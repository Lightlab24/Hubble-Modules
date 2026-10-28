import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ModuleActionResultSchema,
  createModuleHostServices,
  MODULE_HOST_SERVICE_DEFINITIONS,
  ModuleSavedActionsSchema,
  ModuleSavedActionMigrationSchema,
  type ModuleSavedActions,
  ModuleFeedbackSchema,
  ModuleStateSchema,
  type ModuleContext,
  type ModuleExecutionContext,
  type ModuleValues,
  type HubbleModule,
  type ModuleExchange,
} from "./index.js";

/** Real SDK-shaped contexts: templates never omit scope, wrap or cancellation. */
export function createModuleHarness(
  module: HubbleModule,
  settings: ModuleValues = {},
  options: { modules?: ModuleExchange } = {},
) {
  const traces: unknown[] = [],
    feedback: unknown[] = [],
    states: unknown[] = [];
  const controls: unknown[] = [];
  const context: ModuleContext = {
    ...(options.modules ? { modules: options.modules } : {}),
    services: createModuleHostServices((method, value, signal) =>
      context.requestHost!(method, value, signal),
    ),
    scope: {
      kind: "connection",
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
    },
    instanceId: randomUUID(),
    settings: structuredClone(settings),
    log: (value) => {
      traces.push(value);
    },
    publishFeedback: (value) => {
      feedback.push(ModuleFeedbackSchema.parse(value));
    },
    publishState: (value) => {
      states.push(ModuleStateSchema.parse(value));
    },
    requestHost: async (method, value) => {
      if (method === "describe-host-services")
        return {
          scope: context.scope,
          identity: {
            moduleId: "example-fixture",
            version: "1.0.0",
            digest: "0".repeat(64),
          },
          services: MODULE_HOST_SERVICE_DEFINITIONS.map(
            ({ service, version }) => ({
              service,
              version,
              declared: false,
              granted: false,
              available: false,
            }),
          ),
        };
      controls.push(value);
      throw new Error("Host service not provided by this fixture");
    },
  };
  const instance = module.createInstance(context);
  const execution = (
    signal = new AbortController().signal,
  ): ModuleExecutionContext => ({
    executionId: randomUUID(),
    signal,
    gesture: "press",
    wrap: false,
    log: (value) => {
      traces.push(value);
    },
  });
  return { instance, context, execution, traces, feedback, states, controls };
}

/** Transport observations are supplied by the module's simulator, never real hardware. */
export async function assertModuleConformance(options: {
  module: HubbleModule;
  settings?: ModuleValues;
  actionId: string;
  fields: ModuleValues;
  controlCount?: () => number;
  assertReleased?: () => void | Promise<void>;
}) {
  const first = createModuleHarness(options.module, options.settings);
  const second = createModuleHarness(options.module, options.settings);
  const before = options.controlCount?.() ?? 0;
  try {
    await first.instance.start();
    await second.instance.start();
    assert.equal(
      options.controlCount?.() ?? 0,
      before,
      "Startup must not issue control actions",
    );
    const peer = structuredClone(second.feedback);
    const cancelled = ModuleActionResultSchema.parse(
      await first.instance.execute(
        options.actionId,
        options.fields,
        first.execution(AbortSignal.abort()),
      ),
    );
    assert.equal(cancelled.status, "failure");
    if (cancelled.status === "failure")
      assert.equal(cancelled.category, "cancelled");
    assert.equal(
      options.controlCount?.() ?? 0,
      before,
      "Pre-cancelled actions must not issue controls",
    );
    const exercised = ModuleActionResultSchema.parse(
      await first.instance.execute(
        options.actionId,
        options.fields,
        first.execution(),
      ),
    );
    assert.equal(
      exercised.status,
      "success",
      "The supplied valid fixture action must succeed",
    );
    assert.deepEqual(
      second.feedback,
      peer,
      "Instances must not share mutable feedback",
    );
  } finally {
    await first.instance.dispose();
    await first.instance.dispose();
    await second.instance.dispose();
    await second.instance.dispose();
    await options.assertReleased?.();
  }
}

/** A migration receives only owned source expressions and cannot remove or replace their identities. */
export async function assertSavedActionMigration(
  module: HubbleModule,
  actions: ModuleSavedActions,
  from: number,
  to: number,
) {
  if (!module.migrateSavedActions)
    throw new Error("No saved-action migration hook");
  const before = ModuleSavedActionsSchema.parse(actions);
  const frozen = Object.freeze(
    before.map((item) =>
      Object.freeze({
        ...item,
        actionId: Object.freeze(item.actionId),
        actionFields: Object.freeze(item.actionFields),
        feedback: Object.freeze(item.feedback),
      }),
    ),
  );
  const after = await module.migrateSavedActions(frozen, from, to);
  return ModuleSavedActionMigrationSchema.parse({ before, after });
}
