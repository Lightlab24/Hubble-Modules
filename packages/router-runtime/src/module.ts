import {
  createModuleDataPublisher,
  publishModuleData,
} from "@hubble/module-contracts/observations";
import type { ModuleSchemas } from "@hubble/module-runtime-helpers/managed";
import {
  legacyExecution,
  managedModule,
} from "@hubble/module-runtime-helpers/managed";
import { randomUUID } from "node:crypto";
import type {
  HubbleModule,
  ModuleJsonValue,
  ModuleValues,
  ModuleFeedback,
  ModuleFeedbackSubscription,
} from "@hubble/module-sdk";
import { createRouterFeedbackPublisher } from "./feedback-publisher.js";
import { RouterPageRuntime } from "./page-runtime.js";
import { localRouterManager } from "./local-connection-manager.js";
import { connectionView } from "./frontend/connection-view.js";
import { groupPage, editRouterGroups } from "./group-page.js";
import { createRoutingStatePublisher } from "./routing-state-publisher.js";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
} from "@hubble/module-sdk";
import { RouterGroupController } from "./group-controller.js";
import { migrateRouterGroups, prepareRouterGroups } from "./group-document.js";
import {
  routerMatrixAction,
  routerMatrixChoices,
  routerMatrixDestination,
  createRouterMatrixFeedback,
} from "./matrix.js";
import { z } from "zod";
import { routePublic, routerReadiness } from "./public-api.js";
import {
  RouterActionExecutor,
  type RossRouteGroupActionRuntimeContract,
  type RouterActionDefinition,
} from "./actions.js";
import type { RouterConnectionManagerContract } from "./connection-contract.js";
import {
  InterrogateRouterTargetsRequestSchema,
  RouteCrosspointsRequestSchema,
} from "./requests.js";
import type { RouterConnectionDefinition } from "./types.js";

const address = z.int().positive().max(65536);
const levels = z.array(z.int().positive().max(256)).max(256);
const direct = z.object({
  source: address,
  destination: address,
  levels: levels.optional(),
});
const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue;

export function routerModule(
  type: RouterConnectionDefinition["type"],
  createManager: () => RouterConnectionManagerContract,
  schemas: ModuleSchemas<RouterConnectionDefinition, RouterActionDefinition>,
): HubbleModule {
  return {
    migrateDocument: migrateRouterGroups,
    createInstance(context) {
      const connectionEnabled = context.connectionEnabled !== false;
      const manager = connectionEnabled
        ? createManager()
        : localRouterManager();
      const feedbackColumn = randomUUID();
      const feedbackActions = new WeakMap<
        ModuleFeedbackSubscription,
        RouterActionDefinition | null
      >();
      const feedbackPublisher = createRouterFeedbackPublisher(
        (subscriptions) => {
          if (!subscriptions.length || context.scope.kind !== "connection")
            return [];
          const { workspaceId, connectionId } = context.scope;
          const render = createRouterMatrixFeedback(
            workspaceId,
            groupController,
            manager.snapshots(),
          );
          return subscriptions.map((subscription): ModuleFeedback => {
            let action = feedbackActions.get(subscription);
            try {
              if (action === undefined) {
                const fields = subscription.fields;
                const mapped = routerMatrixAction(
                  type,
                  fields,
                  context.settings,
                );
                const schema = schemas.actions[mapped.id];
                if (!schema) throw new Error("Unknown routing feedback");
                action = schema.parse({
                  ...mapped.fields,
                  type: mapped.id,
                  actionId: fields.actionId ?? "matrix-feedback",
                  actionColumnId: fields.actionColumnId ?? feedbackColumn,
                  connectionId,
                  enabled: (fields.values as ModuleValues)?.enabled !== false,
                  interaction: "press",
                });
                feedbackActions.set(subscription, action);
              }
              if (action) return { ...subscription, ...render(action) };
            } catch {
              if (action === undefined) feedbackActions.set(subscription, null);
            }
            return {
              ...subscription,
              state: "unavailable",
              observedAt: null,
              appearance: { backgroundColor: null, glow: null },
            };
          });
        },
        (feedback) => context.publishFeedback(feedback),
      );
      const emitFeedback = feedbackPublisher.invalidate;
      const pageRuntime =
        context.scope.kind === "connection"
          ? new RouterPageRuntime(manager, context.scope.connectionId)
          : null;
      const documents = createModuleDocumentClient(context.services!);
      // Frontends follow this revision, so every open view shows saved routing settings.
      const statePublisher = createRoutingStatePublisher(context.publishState);
      const groupController = new RouterGroupController(
        context,
        manager,
        () => {
          emitFeedback();
          const state = groupController.snapshot();
          statePublisher.setRevision(state.document?.revision ?? null);
          pageRuntime?.notifyGroups([
            state.document?.revision,
            state.contexts.map((item) => [item.reference.contextId, item.name]),
          ]);
        },
      );
      let unsubscribeGroups = () => {};
      let unsubscribeFeedback = () => {};
      const driverSettings = { ...context.settings };
      if (type === "blackmagic-videohub" || type === "aja-kumo")
        for (const field of ["sourceLimit", "destinationLimit"])
          if (driverSettings[field] === null) delete driverSettings[field];
      let started = false;
      let unsubscribePublic = () => {};
      let lastPublic = "";
      const publish = () => {
        if (!connectionEnabled) return;
        const value = routerReadiness(
          manager,
          context.scope.kind === "connection" ? context.scope.connectionId : "",
        );
        const key = JSON.stringify(value);
        if (key === lastPublic) return;
        lastPublic = key;
        void context.modules?.publish("router", 1, value).catch((error) =>
          context.log({
            level: "error",
            stage: "publish-router",
            message: String(error).slice(0, 500),
          }),
        );
      };
      const legacy = managedModule(
        type,
        (definition, context) => {
          const connectionId = definition.connectionId;
          const groups = Object.fromEntries(
            [
              "selectSource",
              "selectDestination",
              "cycleDestination",
              "take",
              "toggleGroupEnabled",
            ].map((method) => [
              method,
              async (input: unknown) => {
                await groupController.dispatch(
                  method as
                    | "selectSource"
                    | "selectDestination"
                    | "cycleDestination"
                    | "take"
                    | "toggleGroupEnabled",
                  input,
                );
              },
            ]),
          ) as unknown as RossRouteGroupActionRuntimeContract;
          const executor = new RouterActionExecutor(
            manager,
            groups,
            context.scope.workspaceId,
          );
          const watches = new Map<string, () => void>();
          let unsubscribeState = () => {};
          let unsubscribePrimary = () => {};
          const emit = (channel: string, value: unknown) => {
            if (!context.publishEvent)
              throw new Error("Host lacks router observation support");
            publishModuleData(
              context.publishEvent.bind(context),
              channel,
              value,
            );
          };
          const publisher = createModuleDataPublisher((channel, value) => {
            if (!context.publishEvent)
              throw new Error("Host lacks router observations");
            context.publishEvent(channel, value);
          });
          return {
            start() {
              manager.reconcile([definition]);
              unsubscribeState = manager.subscribeRouteState(
                connectionId,
                (event) => {
                  emit("router.state", {
                    event,
                    state: manager.routeState(connectionId),
                  });
                  publish();
                  emitFeedback();
                },
              );
              unsubscribePrimary = manager.subscribePrimaryRouteFeedback(
                (snapshots) => {
                  publisher.publish("router.primary", snapshots);
                },
              );
            },
            stop() {
              publisher.close();
              unsubscribeState();
              unsubscribePrimary();
              for (const unsubscribe of watches.values()) unsubscribe();
              watches.clear();
              manager.stop();
            },
            subscribe: (listener) =>
              manager.subscribe((snapshots) => {
                listener(
                  snapshots.map((snapshot) => ({
                    ...snapshot,
                    routingState: manager.routeState(
                      snapshot.definition.connectionId,
                    ),
                  })),
                );
              }),
            execute: (action, execution) =>
              executor.execute(
                action as RouterActionDefinition,
                legacyExecution(execution),
              ),
            async call(method, value, signal) {
              if (signal.aborted)
                throw new Error("Cancelled before router dispatch");
              switch (method) {
                case "refreshNames":
                  return manager.refreshNames(connectionId);
                case "setDestinationLock": {
                  const input = z
                    .strictObject({ destination: address, locked: z.boolean() })
                    .parse(value);
                  if (!manager.setDestinationLock)
                    throw new Error("Destination locking is unavailable");
                  return manager.setDestinationLock(
                    connectionId,
                    input.destination,
                    input.locked,
                    signal,
                  );
                }
                case "recallSalvo": {
                  if (!manager.recallSalvo)
                    throw new Error("Salvos are unavailable");
                  return manager.recallSalvo(
                    connectionId,
                    address.parse(value),
                    signal,
                  );
                }
                case "routeCrosspoints":
                  return manager.routeCrosspoints({
                    ...RouteCrosspointsRequestSchema.parse(value),
                    connectionId,
                  });
                case "interrogateRouteTargets":
                  return manager.interrogateRouteTargets({
                    ...InterrogateRouterTargetsRequestSchema.parse(value),
                    connectionId,
                  });
                case "selectDestination": {
                  manager.selectDestination(connectionId, address.parse(value));
                  return;
                }
                case "selectSource":
                case "submitSelectSource": {
                  const input = z
                    .strictObject({
                      source: address,
                      levels: levels.optional(),
                    })
                    .parse(value);
                  return method === "submitSelectSource" &&
                    manager.submitSelectSource
                    ? manager.submitSelectSource(
                        connectionId,
                        input.source,
                        input.levels,
                      )
                    : manager.selectSource(
                        connectionId,
                        input.source,
                        input.levels,
                      );
                }
                case "take":
                case "submitTake": {
                  const selected =
                    value === null ? undefined : levels.parse(value);
                  return method === "submitTake" && manager.submitTake
                    ? manager.submitTake(connectionId, selected)
                    : manager.take(connectionId, selected);
                }
                case "directRoute":
                case "submitDirectRoute":
                case "submitDirectRouteTracked": {
                  const parsed = direct.parse(value);
                  const input = {
                    connectionId,
                    source: parsed.source,
                    destination: parsed.destination,
                    signal,
                    ...(parsed.levels ? { levels: parsed.levels } : {}),
                  };
                  if (method === "directRoute")
                    return manager.directRoute(input);
                  if (method === "submitDirectRoute")
                    return (
                      manager.submitDirectRoute?.(input) ??
                      manager.directRoute(input)
                    );
                  const id = z.object({ id: z.uuid() }).parse(value).id;
                  const submission = manager.submitDirectRouteTracked(input);
                  const report = (
                    stage: "accepted" | "settled",
                    error?: unknown,
                  ) => {
                    emit("router.submission", {
                      id,
                      stage,
                      ok: error === undefined,
                      message:
                        error instanceof Error
                          ? error.message.slice(0, 1000)
                          : null,
                    });
                  };
                  void submission.accepted.then(
                    () => {
                      report("accepted");
                    },
                    (error: unknown) => {
                      report("accepted", error);
                    },
                  );
                  await submission.settled.then(
                    () => {
                      report("settled");
                    },
                    (error: unknown) => {
                      report("settled", error);
                      throw error;
                    },
                  );
                  return null;
                }
                case "watch": {
                  const input = z
                    .strictObject({
                      id: z.uuid(),
                      destination: address,
                      levels: levels.min(1),
                    })
                    .parse(value);
                  watches.get(input.id)?.();
                  if (!watches.has(input.id) && watches.size >= 1024)
                    throw new Error("Confirmed-route watch capacity reached");
                  watches.set(
                    input.id,
                    manager.watchConfirmedRouteTarget(
                      {
                        connectionId,
                        destination: input.destination,
                        levels: input.levels,
                      },
                      (snapshot) => {
                        emit("router.watch", { id: input.id, snapshot });
                      },
                    ),
                  );
                  return null;
                }
                case "unwatch": {
                  const id = z.uuid().parse(value);
                  watches.get(id)?.();
                  watches.delete(id);
                  return null;
                }
                default:
                  throw new Error("Unsupported router service");
              }
            },
          };
        },
        {
          kind: "submitted",
          summary:
            "Router adapter completed at its existing command submission boundary",
        },
        schemas,
      ).createInstance({
        ...context,
        settings: driverSettings,
        publishState: statePublisher.publish,
      });
      return {
        ...legacy,
        async start() {
          started = true;
          await legacy.start();
          await groupController.start();
          pageRuntime?.start();
          unsubscribeGroups = groupController.runtime.subscribe(emitFeedback);
          unsubscribePublic = manager.subscribe(() => {
            publish();
            emitFeedback();
          });
          unsubscribeFeedback =
            manager.subscribePrimaryRouteFeedback(emitFeedback);
          publish();
        },
        async execute(id, fields, execution) {
          if (id === "matrix") {
            try {
              const mapped = routerMatrixAction(type, fields, context.settings);
              if (
                !connectionEnabled &&
                !mapped.id.endsWith(".toggle-group-enabled")
              )
                return {
                  status: "failure",
                  category: "unavailable",
                  message: "Router connection is disabled",
                };
              return legacy.execute(
                mapped.id,
                {
                  actionId: fields.actionId ?? randomUUID(),
                  actionColumnId: fields.actionColumnId ?? randomUUID(),
                  ...mapped.fields,
                },
                execution,
              );
            } catch (error) {
              return {
                status: "failure",
                category: "invalid-config",
                message:
                  error instanceof Error
                    ? error.message
                    : "Invalid routing action",
              };
            }
          }
          if (!connectionEnabled && !id.endsWith(".toggle-group-enabled"))
            return {
              status: "failure",
              category: "unavailable",
              message: "Router connection is disabled",
            };
          if (id !== "route") return legacy.execute(id, fields, execution);
          if (!started || context.scope.kind !== "connection")
            return {
              status: "failure",
              category: "unavailable",
              message: "Router module is stopped",
            };
          return routePublic(
            manager,
            context.scope.connectionId,
            fields,
            execution,
          );
        },
        queryData(query) {
          if (query.version === 1 && query.id === "prepare-routing-groups")
            return prepareRouterGroups(query.input);
          if (query.version === 1 && query.id === "routing-groups")
            return json(
              groupPage(
                groupController,
                z
                  .uuid()
                  .nullable()
                  .parse(query.input ?? null),
              ),
            );
          if (
            query.id !== "router" ||
            query.version !== 1 ||
            context.scope.kind !== "connection"
          )
            throw new Error("Unsupported router query");
          return routerReadiness(manager, context.scope.connectionId);
        },
        async discoverChoices(query) {
          if (context.scope.kind !== "connection")
            throw new Error("Router scope unavailable");
          await groupController.refresh();
          return routerMatrixChoices(
            type,
            manager,
            groupController,
            context.scope.connectionId,
            query,
          );
        },
        async subscribeFeedback(subscriptions) {
          const matrix = subscriptions.filter((item) => item.id === "matrix");
          if (connectionEnabled)
            await groupController.observeMatrixDestinations(
              matrix.flatMap(({ fields }) => {
                const row = routerMatrixDestination(type, fields);
                return row ? [row] : [];
              }),
            );
          feedbackPublisher.subscribe(matrix);
        },
        async call(method, value, execution) {
          const routingSettingsCall = async (
            commandId: string,
            input: ModuleJsonValue,
          ) => {
            if (commandId === "groups") {
              await groupController.refresh();
              return json(
                groupPage(groupController, z.uuid().nullable().parse(input)),
              );
            }
            if (commandId === "edit-group")
              return json(
                await editRouterGroups(
                  groupController,
                  input,
                  execution.signal,
                ),
              );
            throw new Error("Unknown routing settings command");
          };
          if (method === "page.routing-settings") {
            const input = z
              .strictObject({
                sectionId: z.literal("routing-settings"),
                commandId: z.string(),
                value: z.json(),
              })
              .parse(value);
            return routingSettingsCall(
              input.commandId,
              input.value as ModuleJsonValue,
            );
          }
          if (method === "page.routing") {
            const input = z
              .strictObject({
                sectionId: z.literal("router"),
                commandId: z.string(),
                value: z.json(),
              })
              .parse(value);
            if (!pageRuntime) throw new Error("Router page unavailable");
            switch (input.commandId) {
              case "settings": {
                const snapshot = manager.snapshots()[0];
                if (!snapshot) throw new Error("Router connection unavailable");
                const saved = await documents.read(
                  "router-view",
                  execution.signal,
                );
                const zoom = z
                  .object({ zoom: z.number() })
                  .safeParse(saved.value);
                return json({
                  connection: connectionView(snapshot),
                  zoom: zoom.success ? zoom.data.zoom : 100,
                });
              }
              case "set-zoom": {
                const zoom = z
                  .union([
                    z.literal(75),
                    z.literal(90),
                    z.literal(100),
                    z.literal(110),
                    z.literal(125),
                    z.literal(150),
                  ])
                  .parse(input.value);
                for (let attempt = 0; attempt < 3; attempt++) {
                  const current = await documents.read(
                    "router-view",
                    execution.signal,
                  );
                  try {
                    await documents.write(current, { zoom }, execution.signal);
                    return null;
                  } catch (error) {
                    if (
                      !(error instanceof ModuleDocumentConflictError) ||
                      attempt === 2
                    )
                      throw error;
                  }
                }
                throw new Error("Router zoom changed; try again");
              }
              case "groups":
              case "edit-group":
                return routingSettingsCall(
                  input.commandId,
                  input.value as ModuleJsonValue,
                );
              default:
                return pageRuntime.call(
                  input.commandId,
                  input.value,
                  execution.signal,
                );
            }
          }
          if (method === "editRoutingGroups")
            return json(
              await editRouterGroups(groupController, value, execution.signal),
            );
          return legacy.call!(method, value, execution);
        },
        async dispose() {
          started = false;
          feedbackPublisher.close();
          unsubscribeGroups();
          unsubscribePublic();
          unsubscribeFeedback();
          pageRuntime?.stop();
          await groupController.stop();
          await legacy.dispose();
        },
      };
    },
  };
}
