import { recordingCheckpoint } from "./recording-checkpoint.js";
import { z } from "zod";
import { actionResult } from "./recording-result.js";
import { observeRcpPeers } from "./rcp-peers.js";
import { publishModuleData } from "@hubble/module-contracts/observations";
import type { HubbleModule, ModuleJsonValue } from "@hubble/module-sdk";
import { CccController } from "./ccc-controller.js";
import {
  CccCommandRequestSchema,
  CccConfigSchema,
  applyCccMutation,
  CccCommandSchema,
  CccMutationRequestSchema,
} from "./config.js";

const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue;
export function createCccModule(
  createController: (
    store: ConstructorParameters<typeof CccController>[0],
  ) => CccController = (store) => new CccController(store),
): HubbleModule {
  return {
    createInstance(context) {
      if (context.scope.kind !== "host" || context.scope.capabilityId !== "ccc")
        throw new Error("CCC requires its host capability scope");
      const workspaceId = context.scope.workspaceId;
      const controller = createController({
        read: async () => {
          if (!context.requestHost) throw new Error("CCC store unavailable");
          return CccConfigSchema.parse(
            await context.requestHost("ccc-store", { method: "read" }),
          );
        },
        mutate: async (request) => {
          if (!context.requestHost) throw new Error("CCC store unavailable");
          const current = CccConfigSchema.parse(
            await context.requestHost("ccc-store", { method: "read" }),
          );
          const next = applyCccMutation(current, request.mutation);
          return CccConfigSchema.parse(
            await context.requestHost("ccc-store", {
              method: "mutate",
              request: json({
                workspaceId,
                mutation: {
                  kind: "replace",
                  expectedRevision: current.revision,
                  rows: next.rows,
                  ...(next.singleSwitch === undefined
                    ? {}
                    : { singleSwitch: next.singleSwitch }),
                },
              }),
            }),
          );
        },
      });
      if (!context.modules)
        throw new Error("CCC requires module exchange support");
      const peers = observeRcpPeers(context.modules, controller);
      let checkpoint: ReturnType<typeof recordingCheckpoint> | undefined;
      let savedCheckpoint = "";
      let scheduled: ReturnType<typeof setImmediate> | undefined;
      let stopped = false;
      const feedbackStates = new Map<string, boolean | null | undefined>();
      let unsubscribe = () => {};
      const emit = () => {
        if (!context.publishEvent)
          throw new Error("CCC observation support unavailable");
        const state = controller.state();
        const feedback = controller.feedback();
        for (const id of [
          "single-switch",
          "enable-all-cameras",
          "roll-enabled-cameras",
          "stop-enabled-cameras",
          "roll-toggle-enabled-cameras",
        ]) {
          const value = feedback[`${id}/`];
          if (feedbackStates.has(id) && feedbackStates.get(id) === value)
            continue;
          feedbackStates.set(id, value);
          context.publishFeedback({
            id,
            state:
              value == null ? "unavailable" : value ? "active" : "inactive",
            observedAt: value == null ? null : new Date().toISOString(),
          });
        }
        publishModuleData(
          context.publishEvent.bind(context),
          "host.ccc",
          state,
        );
        const selected = new Set(
          state.config.rows
            .filter((row) => row.enabled)
            .map((row) => row.rowId),
        );
        const unavailable = state.rows.find(
          (row) => selected.has(row.rowId) && row.connection !== "online",
        );
        context.publishState({
          phase: unavailable
            ? unavailable.connection === "connecting"
              ? "connecting"
              : "unavailable"
            : "ready",
          message: unavailable?.message ?? null,
          observedAt: new Date().toISOString(),
          values: {},
        });
      };
      return {
        async start() {
          if (!context.runtimeDirectory)
            throw new Error("CCC requires local module runtime storage");
          checkpoint = recordingCheckpoint(context.runtimeDirectory);
          controller.recording.restore(
            checkpoint.checkpoint,
            checkpoint.recovery,
          );
          checkpoint.write(controller.recording.checkpoint());
          savedCheckpoint = JSON.stringify(controller.recording.checkpoint());
          unsubscribe = controller.subscribe(() => {
            if (stopped) return;
            scheduled ??= setImmediate(() => {
              scheduled = undefined;
              if (!stopped) emit();
            });
            const next = controller.recording.checkpoint();
            const json = JSON.stringify(next);
            if (json !== savedCheckpoint) {
              checkpoint?.write(next);
              savedCheckpoint = json;
            }
          });
          await controller.activate(workspaceId);
          emit();
          await peers.start();
        },
        choices(provider) {
          if (provider === "rcps") return peers.choices();
          if (provider === "cameras")
            return controller
              .state()
              .config.rows.map((row) => ({
                id: row.rowId,
                label: `${row.cameraNumber ?? "?"} — ${row.rcpIp || "Unconfigured"}`,
              }));
          return [];
        },
        async execute(id, fields, execution) {
          try {
            if (id === "record-rcp") {
              const request = z
                .strictObject({
                  connectionId: z.uuid(),
                  command: z.enum([
                    "record-camera",
                    "record-group-all",
                    "start-enabled-cameras",
                    "stop-enabled-cameras",
                  ]),
                  cameraNumber: z.int().min(1).max(999999).optional(),
                })
                .parse(fields);
              return actionResult(
                await controller.cameraCommand(
                  request.connectionId,
                  request.command,
                  request.cameraNumber,
                  execution.signal,
                ),
                execution,
              );
            }
            const action = CccCommandRequestSchema.parse({
              workspaceId,
              command: CccCommandSchema.parse(
                id === "ccc.command" ? fields.command : id,
              ),
              ...((fields.cameraId ?? fields.rowId) == null
                ? {}
                : { rowId: fields.cameraId ?? fields.rowId }),
            });
            const batch = await controller.command(
              {
                workspaceId,
                command: action.command,
                ...(action.rowId ? { rowId: action.rowId } : {}),
              },
              execution.signal,
            );
            return actionResult(batch.moduleResult, execution);
          } catch (error) {
            return {
              status: "failure",
              category: execution.signal.aborted ? "cancelled" : "rejected",
              code: "action_exception",
              message:
                error instanceof Error
                  ? error.message.slice(0, 1000)
                  : "CCC command failed",
            };
          }
        },
        async call(method, value, execution) {
          if (method === "activate") {
            await controller.activate(workspaceId);
            return json(controller.state());
          }
          if (method === "mutate")
            return json(
              await controller.mutate({
                ...CccMutationRequestSchema.parse(value),
                workspaceId,
              }),
            );
          if (method === "command")
            return json(
              await controller.command(
                { ...CccCommandRequestSchema.parse(value), workspaceId },
                execution.signal,
              ),
            );
          throw new Error("Unsupported CCC service");
        },
        async dispose() {
          stopped = true;
          if (scheduled) clearImmediate(scheduled);
          unsubscribe();
          await peers.stop();
          await controller.stop();
          checkpoint?.write(controller.recording.checkpoint(), true);
        },
      };
    },
  };
}
export default createCccModule();
