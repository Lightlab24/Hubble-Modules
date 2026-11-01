import { createHash } from "node:crypto";
import {
  legacyExecution,
  managedModule,
} from "@hubble/module-runtime-helpers/managed";
import { withModuleMatrix } from "@hubble/module-runtime-helpers/matrix";
import type { HubbleModule, ModuleContext } from "@hubble/module-sdk";
import { z } from "zod";
import {
  actionSchemas,
  ActionDefinitionSchema,
  type ActionDefinition,
} from "./actions.js";
import {
  ConnectionDefinitionSchema,
  LiveGradeApplicationSchema,
  LiveGradeSlotPositionSchema,
  liveGradeActionApplication,
  rankLiveGradeSlotSuggestions,
  type ConnectionDefinition,
} from "./config.js";
import { LiveGradeActionExecutor } from "./livegrade-action-executor.js";
import { LiveGradeConnectionManager } from "./livegrade-connection-manager.js";
import { createLiveGradeNativeClient } from "./native-menu-client.js";
import {
  matrix,
  liveGradeMatrixAction,
  liveGradeMatrixFeedback,
} from "./matrix.js";

export function createLiveGradeModule(
  createManager = (context: ModuleContext) =>
    new LiveGradeConnectionManager({
      createClient: (target) =>
        createLiveGradeNativeClient(context.services, target),
    }),
): HubbleModule {
  const base: HubbleModule = {
    createInstance(context) {
      const manager = createManager(context);
      const executor = new LiveGradeActionExecutor(manager);
      const managed = managedModule<ConnectionDefinition, ActionDefinition>(
        "livegrade",
        (definition) => ({
          start: () => {
            manager.reconcile([definition]);
          },
          stop: () => {
            manager.stop();
          },
          subscribe: (listener) => manager.subscribe(listener),
          call(method, value, signal) {
            signal.throwIfAborted();
            if (method === "requestAccessibilityPermission")
              return manager.requestAccessibilityPermission(
                definition.connectionId,
              );
            if (method === "selectSlot") {
              const input = z
                .strictObject({
                  application: LiveGradeApplicationSchema.optional(),
                  position: LiveGradeSlotPositionSchema.nullable(),
                  query: z.string().max(256),
                })
                .parse(value);
              return manager.selectSlot(definition.connectionId, {
                ...input,
                signal,
              });
            }
            throw new Error("Unsupported LiveGrade service");
          },
          execute(action, execution) {
            const input = liveGradeMatrixAction(
              {
                values: {
                  ...action,
                  application:
                    action.application ??
                    liveGradeActionApplication("select-slot", definition),
                },
              },
              context.settings,
            );
            return executor.execute(
              ActionDefinitionSchema.parse({ ...action, ...input.fields }),
              legacyExecution(execution),
            );
          },
        }),
        {
          kind: "response",
          summary:
            "The exact LiveGrade slot menu command completed without a reported focus change",
        },
        { connection: ConnectionDefinitionSchema, actions: actionSchemas },
      ).createInstance(context);
      return {
        ...managed,
        discoverChoices(query, observation) {
          observation.signal.throwIfAborted();
          if (query.provider !== "slots")
            throw new Error("Unknown LiveGrade choice provider");
          const snapshot = manager.snapshots()[0];
          const fallback = liveGradeActionApplication("select-slot", {
            generation: context.settings.generation === 6 ? 6 : 7,
            edition:
              context.settings.edition === "frontier" ? "frontier" : "standard",
          });
          const application = LiveGradeApplicationSchema.parse(
            query.draft["module.application"] ?? query.draft.application ?? fallback,
          );
          const catalog = snapshot?.applications?.find(
            (item) => item.application === application,
          );
          const choices =
            catalog?.phase === "ready"
              ? rankLiveGradeSlotSuggestions(catalog.slots, query.search).map(
                  (slot) => ({
                    id: String(slot.position),
                    label: `${slot.position} — ${slot.menuTitle}`.slice(0, 160),
                    values: {
                      slotId: slot.menuTitle,
                      sequence: slot.position,
                      assignmentMode: "manual",
                    },
                  }),
                )
              : [];
          const revision = createHash("sha256")
            .update(
              JSON.stringify([
                application,
                catalog?.applicationVersion,
                catalog?.slots,
                query.search,
              ]),
            )
            .digest("hex");
          const offset = query.cursor === null ? 0 : Number(query.cursor);
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            offset > choices.length ||
            (query.cursor !== null && query.catalogRevision !== revision)
          )
            throw new Error("Refresh LiveGrade slot choices");
          return {
            revision,
            choices: choices.slice(offset, offset + query.limit),
            nextCursor:
              offset + query.limit < choices.length
                ? String(offset + query.limit)
                : null,
          };
        },
      };
    },
  };
  return withModuleMatrix(
    base,
    matrix,
    liveGradeMatrixAction,
    liveGradeMatrixFeedback,
    ["driver.snapshots"],
  );
}
export default createLiveGradeModule();
