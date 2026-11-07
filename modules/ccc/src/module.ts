import { setTimeout as delay } from "node:timers/promises";
import { recordingCheckpoint } from "./recording-checkpoint.js";
import { z } from "zod";
import { actionResult } from "./recording-result.js";
import { observeRcpPeers } from "./rcp-peers.js";
import { publishModuleData } from "@hubble/module-contracts/observations";
import { withModuleMatrix } from "@hubble/module-runtime-helpers/matrix";
import { choicePage } from "@hubble/module-runtime-helpers/choices";
import {
  matrix,
  matrixAction,
  matrixFeedback,
  feedbackCommands,
} from "./matrix.js";
import type { HubbleModule, ModuleJsonValue } from "@hubble/module-sdk";
import {
  CccController,
  cccCommandControlsSelection,
} from "./ccc-controller.js";
import {
  createCccDocumentStore,
  documentId,
  migrateCccDocument,
  prepareCccDocument,
} from "./document.js";
import { ModuleTableRowsSchema } from "@hubble/module-sdk";
import {
  CccCommandRequestSchema,
  CccCommandSchema,
  CccMutationRequestSchema,
  resolveCccCameraRow,
} from "./config.js";

const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue;
export function createCccModule(
  createController: (
    store: ConstructorParameters<typeof CccController>[0],
  ) => CccController = (store) => new CccController(store),
): HubbleModule {
  const module: HubbleModule = {
    migrateDocument: migrateCccDocument,
    createInstance(context) {
      if (context.scope.kind !== "host" || context.scope.capabilityId !== "ccc")
        throw new Error("CCC requires its host capability scope");
      const workspaceId = context.scope.workspaceId;
      if (!context.services)
        throw new Error("CCC document service unavailable");
      const store = createCccDocumentStore(context.services);
      const controller = createController(store);
      const documentAbort = new AbortController();
      let documentWatch: Promise<void> | undefined;
      const cameraRows = (value: ModuleJsonValue) => {
        const input = z.record(z.string(), z.json()).parse(value);
        const state = controller.state();
        return {
          settings: input,
          rows: ModuleTableRowsSchema.parse(input.cameras ?? []).map((row) => {
            const saved = state.config.rows.find(
              (item) => item.rowId === row.id,
            );
            const observation =
              saved &&
              saved.rcpIp === String(row.values.rcpIp ?? "") &&
              String(saved.cameraNumber ?? "") ===
                String(row.values.cameraNumber ?? "")
                ? state.rows.find((item) => item.rowId === row.id)
                : undefined;
            return {
              id: row.id,
              values: {
                name: observation?.name ?? "",
                connection: observation?.connection ?? "incomplete",
                recording: observation?.recording ?? "unknown",
                message:
                  observation?.lastResult?.message ??
                  observation?.message ??
                  "Enter an RCP IP and camera number",
              },
            };
          }),
        };
      };
      if (!context.modules)
        throw new Error("CCC requires module exchange support");
      const peers = observeRcpPeers(context.modules, controller);
      let checkpoint: ReturnType<typeof recordingCheckpoint> | undefined;
      let savedCheckpoint = "";
      let scheduled: ReturnType<typeof setImmediate> | undefined;
      let stopped = false;
      let publishedSnapshot: string | undefined;
      let publishedStatus: string | undefined;
      let documentError: string | null = null;
      const feedbackStates = new Map<string, boolean | null | undefined>();
      const cameraFeedbackStates = new Map<
        string,
        boolean | null | undefined
      >();
      let unsubscribe = () => {};
      const emit = () => {
        if (!context.publishEvent)
          throw new Error("CCC observation support unavailable");
        const state = controller.state();
        const feedback = controller.feedback();
        const cameraIds = new Set(state.config.rows.map((row) => row.rowId));
        for (const cameraId of cameraFeedbackStates.keys()) {
          if (cameraIds.has(cameraId)) continue;
          context.publishFeedback({
            id: "toggle-camera-enabled",
            fields: { cameraId },
            state: "unavailable",
            observedAt: null,
          });
          cameraFeedbackStates.delete(cameraId);
        }
        for (const cameraId of cameraIds) {
          const value = feedback[`toggle-camera-enabled/${cameraId}`];
          if (
            cameraFeedbackStates.has(cameraId) &&
            cameraFeedbackStates.get(cameraId) === value
          )
            continue;
          cameraFeedbackStates.set(cameraId, value);
          context.publishFeedback({
            id: "toggle-camera-enabled",
            fields: { cameraId },
            state:
              value == null ? "unavailable" : value ? "active" : "inactive",
            observedAt: value == null ? null : new Date().toISOString(),
          });
        }
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
        // Peer refreshes and repeated device observations can leave the visible
        // state unchanged. Do not fan those out through every host subscriber.
        const snapshot = JSON.stringify(state);
        if (snapshot !== publishedSnapshot) {
          publishModuleData(
            context.publishEvent.bind(context),
            "host.ccc",
            state,
          );
          publishedSnapshot = snapshot;
        }
        const selected = new Set(
          state.config.rows
            .filter((row) => row.enabled)
            .map((row) => row.rowId),
        );
        const unavailable = state.rows.filter(
          (row) => selected.has(row.rowId) && row.connection !== "online",
        );
        const status = {
          // Selection is a local workspace operation. Camera availability is
          // reported per row and must not disable selection feedback.
          phase: documentError ? ("error" as const) : ("ready" as const),
          message: documentError ?? unavailable[0]?.message ?? null,
          values: {
            enabledCameraCount: selected.size,
            unavailableCameraCount: unavailable.length,
            singleSwitch: state.config.singleSwitch ? "On" : "Off",
            cameraRows: cameraRows(store.value()),
            cameraSelection: {
              revision: store.revision() ?? null,
              rows: state.config.rows.map((row) => ({
                id: row.rowId,
                values: { enabled: row.enabled },
              })),
            },
          },
        };
        // observedAt timestamps a status change, not a periodic heartbeat.
        const statusSignature = JSON.stringify(status);
        if (statusSignature !== publishedStatus) {
          context.publishState({
            ...status,
            observedAt: new Date().toISOString(),
          });
          publishedStatus = statusSignature;
        }
      };
      const showDocumentError = (message: string) => {
        documentError = message;
        try {
          emit();
        } catch {
          // A document too broken to summarize still has to report that.
          publishedStatus = undefined;
          context.publishState({
            phase: "error",
            message,
            observedAt: new Date().toISOString(),
            values: {},
          });
        }
      };
      // A version switch refuses one watch request while its saved selection lands,
      // so only a second failure in a row is worth showing. Nothing stops retrying.
      const watchDocument = async () => {
        let backoff = 250;
        let failures = 0;
        while (!stopped) {
          try {
            for await (const _document of store.client.watch(
              documentId,
              documentAbort.signal,
            )) {
              if (stopped) return;
              await controller.activate(workspaceId);
              documentError = null;
              emit();
              failures = 0;
            }
          } catch (error) {
            if (stopped) return;
            const message =
              error instanceof Error
                ? error.message.slice(0, 1000)
                : "Camera document unavailable";
            failures += 1;
            context.log({
              level: failures > 1 ? "error" : "info",
              stage: "document-watch",
              message,
            });
            if (failures > 1) showDocumentError(message);
          }
          await delay(backoff, undefined, {
            signal: documentAbort.signal,
          }).catch(() => {});
          backoff = Math.min(5000, backoff * 2);
        }
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
          documentWatch = watchDocument();
        },
        queryData(query) {
          if (query.version !== 1)
            throw new Error("Unsupported camera query version");
          if (query.id === "prepare-cameras") {
            try {
              return {
                status: "accepted",
                value: prepareCccDocument(query.input),
              };
            } catch (error) {
              const message =
                error instanceof z.ZodError
                  ? (error.issues[0]?.message ?? "Invalid camera settings")
                  : error instanceof Error
                    ? error.message
                    : "Invalid camera settings";
              return {
                status: "invalid",
                message: message.slice(0, 1000),
                issues: [],
              };
            }
          }
          if (query.id === "camera-preview")
            return json({ cameraRows: cameraRows(query.input) });
          throw new Error("Unknown camera query");
        },
        choices(provider) {
          if (provider === "rcps") return peers.choices();
          if (provider === "cameras")
            return controller.state().config.rows.map((row) => ({
              id: row.rowId,
              label: `${row.cameraNumber ?? "?"} — ${row.rcpIp || "Unconfigured"}`,
            }));
          return [];
        },
        discoverChoices(query) {
          if (query.provider !== "matrix-cameras")
            throw new Error("Unknown CCC choice provider");
          const rows = controller.state().config.rows;
          return choicePage(
            query,
            rows.map((row) => ({
              id: row.rowId,
              label: `${row.cameraNumber ?? "?"} — ${row.rcpIp || "Unconfigured"}`,
              values: {
                cameraId:
                  row.cameraNumber !== null &&
                  rows.filter(
                    (other) => other.cameraNumber === row.cameraNumber,
                  ).length === 1
                    ? String(row.cameraNumber)
                    : row.rowId,
              },
            })),
          );
        },
        async execute(id, fields, execution) {
          try {
            if (id === "record-rcp") {
              await controller.activate(workspaceId);
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
                : {
                    rowId: resolveCccCameraRow(
                      controller.state().config.rows,
                      String(fields.cameraId ?? fields.rowId),
                    )?.rowId,
                  }),
            });
            if (!cccCommandControlsSelection(action.command))
              await controller.activate(workspaceId);
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
          if (method === "page.ccc") {
            const input = z
              .object({
                sectionId: z.literal("selection"),
                commandId: z.enum(["single-switch", "enable-all-cameras"]),
              })
              .parse(value);
            await controller.command(
              { workspaceId, command: input.commandId },
              execution.signal,
            );
            return {
              message:
                input.commandId === "single-switch"
                  ? `Single switch ${controller.state().config.singleSwitch ? "on" : "off"}`
                  : "Camera selection updated",
            };
          }
          if (method === "activate") {
            // Startup and the document watcher own configuration adoption. The host
            // requests this snapshot while reconciling saved documents, possibly
            // while an action is waiting for the host's next storage transaction.
            // Joining the controller's command queue here would deadlock both.
            return json(controller.state());
          }
          if (method === "mutate")
            return json(
              await controller.mutate({
                ...CccMutationRequestSchema.parse(value),
                workspaceId,
              }),
            );
          if (method === "command") {
            const request = {
              ...CccCommandRequestSchema.parse(value),
              workspaceId,
            };
            if (!cccCommandControlsSelection(request.command))
              await controller.activate(workspaceId);
            return json(await controller.command(request, execution.signal));
          }
          throw new Error("Unsupported CCC service");
        },
        async dispose() {
          stopped = true;
          documentAbort.abort();
          await documentWatch;
          if (scheduled) clearImmediate(scheduled);
          unsubscribe();
          await peers.stop();
          await controller.stop();
          checkpoint?.write(controller.recording.checkpoint(), true);
        },
      };
    },
  };
  return withModuleMatrix(
    module,
    matrix,
    matrixAction,
    matrixFeedback,
    ["host.ccc"],
    feedbackCommands,
  );
}
export default createCccModule();
