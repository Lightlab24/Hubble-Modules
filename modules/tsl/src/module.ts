import { z } from "zod";
import { createHash } from "node:crypto";
import { MatrixFeedback } from "./matrix-feedback.js";
import { managedModule } from "@hubble/module-runtime-helpers/managed";
import type { HubbleModule } from "@hubble/module-sdk";
import { actionSchemas, type ActionDefinition } from "./actions.js";
import {
  ConnectionDefinitionSchema,
  type ConnectionDefinition,
} from "./config.js";
import { TslReceiver } from "./receiver.js";
import { TslPresentation } from "./presentation.js";

const module: HubbleModule = {
  createInstance(context) {
    let receiver: TslReceiver;
    const presentation = new TslPresentation(context, () => receiver);
    const matrixFeedback = new MatrixFeedback(context, () => receiver);
    const legacy = managedModule<ConnectionDefinition, ActionDefinition>(
      "tsl",
      (definition, context) => {
        if (definition.type !== "tsl")
          throw new Error("Invalid TSL connection");
        let listener: (snapshots: readonly unknown[]) => void = () => {};
        receiver = new TslReceiver(definition, () => {
          emit();
        });
        const emit = () => {
          const state = receiver.snapshot();
          listener([
            { definition, phase: state.phase, lastError: state.error, state },
          ]);
          presentation.emit();
          matrixFeedback.emit();
        };
        return {
          start: () => receiver.start(),
          stop: () => receiver.stop(),
          subscribe: (callback) => {
            listener = callback;
            emit();
            return () => {
              listener = () => {};
            };
          },
          async execute(action) {
            if (action.type === "tsl.tally-feedback")
              return { outcome: "success" };
            try {
              await matrixFeedback.executeLegacy(action);
              return { outcome: "success" };
            } catch {
              return {
                outcome: "failure",
                errorCode: "action_exception",
                errorMessage:
                  action.type === "tsl.tally-switch"
                    ? "TALLY Switch follow state could not be saved"
                    : action.type === "tsl.follow"
                      ? "Button tally follow state could not be saved"
                      : "TSL indication could not be saved; check the target feedback column",
              };
            }
          },
        };
      },
      {
        kind: "local",
        summary: "Tally module confirmed the requested control state was saved",
      },
      {
        connection: ConnectionDefinitionSchema.unwrap().strip(),
        actions: actionSchemas,
      },
    ).createInstance({
      ...context,
      settings: { name: "TSL UMD", ...context.settings },
      publishState: () => {},
    });
    return {
      ...legacy,
      async start() {
        await matrixFeedback.start();
        await legacy.start();
      },
      subscribeFeedback(subscriptions) {
        matrixFeedback.subscribe(subscriptions);
      },
      async execute(id, fields, execution) {
        if (id !== "matrix" && id !== "set-column-indication")
          return legacy.execute(id, fields, execution);
        try {
          execution.signal.throwIfAborted();
          if (id === "set-column-indication") {
            const control = z
              .object({ columnId: z.string().uuid(), enabled: z.boolean() })
              .parse(fields);
            if (!matrixFeedback.columns().includes(control.columnId))
              throw new Error("This receiver does not own that column");
            await matrixFeedback.executeLegacy({
              type: "tsl.set-indication",
              actionId: control.columnId,
              actionColumnId: control.columnId,
              targetColumnId: control.columnId,
              indication: control.enabled,
            });
          } else await matrixFeedback.execute(fields, execution.signal);
          return {
            status: "success",
            evidence: {
              kind: "local",
              summary: "Tally module confirmed its state was saved",
            },
          };
        } catch (error) {
          return {
            status: "failure",
            category: execution.signal.aborted ? "cancelled" : "invalid-config",
            message:
              error instanceof Error ? error.message : "Tally action failed",
          };
        }
      },
      async call(method, value, execution) {
        execution.signal.throwIfAborted();
        if (method === "matrix-control") {
          const control = z
            .object({
              controlId: z.literal("toggle-following"),
              actionColumnId: z.string().uuid(),
            })
            .parse(value);
          await matrixFeedback.executeLegacy({
            type: "tsl.follow",
            actionId: control.actionColumnId,
            actionColumnId: control.actionColumnId,
            followMode: "toggle",
          });
          return null;
        }
        if (legacy.call) return legacy.call(method, value, execution);
        throw new Error("Unknown Tally control");
      },
      async discoverChoices(query) {
        if (query.provider === "tally-switch-peers")
          return {
            revision: "peers",
            nextCursor: null,
            choices: ((await context.modules?.discover()) ?? [])
              .filter(
                (peer) =>
                  peer.peer.moduleId === "hubble-tally-switch" &&
                  peer.peer.kind === "connection",
              )
              .map((peer) => ({
                id:
                  peer.peer.kind === "connection" ? peer.peer.connectionId : "",
                label: peer.name,
              }))
              .slice(0, query.limit),
          };
        if (query.provider !== "matrix-addresses") {
          if (query.provider !== "feedback-mappings")
            throw new Error("Unknown choice provider");
          return {
            revision: "mappings",
            choices: presentation.mappings
              .map((row) => ({ id: row.id, label: row.values.name }))
              .slice(0, query.limit),
            nextCursor: null,
          };
        }
        const screen =
          context.settings.protocol === "3.1"
            ? 0
            : Number(query.draft.tallyScreen ?? 0);
        const all = receiver
          .snapshot()
          .displays.filter(
            (display) =>
              display.screen === screen &&
              display.protocol === context.settings.protocol,
          )
          .map((display) => ({
            id: String(display.address),
            label: `${display.address} · ${display.label || "Unnamed"}`.slice(
              0,
              160,
            ),
          }))
          .filter((choice) =>
            `${choice.id} ${choice.label}`
              .toLocaleLowerCase()
              .includes(query.search.toLocaleLowerCase()),
          )
          .sort((a, b) => Number(a.id) - Number(b.id));
        const revision = createHash("sha256")
          .update(JSON.stringify(all))
          .digest("hex");
        if (query.catalogRevision && query.catalogRevision !== revision)
          throw new Error("Address list changed; search again");
        const offset =
          query.cursor === null
            ? 0
            : z.coerce
                .number()
                .int()
                .min(0)
                .max(all.length)
                .parse(query.cursor);
        return {
          revision,
          choices: all.slice(offset, offset + query.limit),
          nextCursor:
            offset + query.limit < all.length
              ? String(offset + query.limit)
              : null,
        };
      },
      async choices(provider) {
        if (provider === "tally-switch-peers")
          return ((await context.modules?.discover()) ?? [])
            .filter(
              (peer) =>
                peer.peer.moduleId === "hubble-tally-switch" &&
                peer.peer.kind === "connection",
            )
            .map((peer) => ({
              id: peer.peer.kind === "connection" ? peer.peer.connectionId : "",
              label: peer.name,
            }));
        if (provider !== "feedback-mappings") return [];
        return presentation.mappings.map((row) => ({
          id: row.id,
          label: row.values.name,
        }));
      },
      queryData(query) {
        if (query.id === "matrix-columns" && query.version === 1)
          return matrixFeedback.columns();
        if (query.id !== "tally" || query.version !== 1)
          throw new Error("Unsupported tally query");
        return presentation.shared();
      },
      async dispose() {
        presentation.close();
        await matrixFeedback.close();
        await legacy.dispose();
      },
    };
  },
};

export default module;
