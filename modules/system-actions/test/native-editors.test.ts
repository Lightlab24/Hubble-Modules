import { expect, it, vi } from "vitest";
import {
  createModuleHostServices,
  ModuleChoicePageSchema,
  ModuleFeedbackSchema,
  type ModuleChoiceQuery,
  type ModuleContext,
  type ModuleExecutionContext,
} from "@hubble/module-sdk";
import { unavailableKeyboardBridgeResponse } from "@hubble/module-contracts/keyboard";
import { systemDiscovery } from "../src/discovery.js";
import { matrixAction, matrix } from "../src/matrix.js";
import module from "../src/module.js";

const signal = new AbortController().signal;
const query = (provider: string, draft = {}): ModuleChoiceQuery => ({
  version: 2,
  provider,
  draft,
  search: "",
  cursor: null,
  limit: 128,
  requestRevision: 1,
});
const response = () => ({
  ...unavailableKeyboardBridgeResponse(),
  available: true,
  permissionGranted: true,
  errorCode: null,
  message: null,
  applications: [
    { name: "Running app", bundleId: "com.example.running", pid: 5 },
  ],
  installedApplications: [
    { name: "Installed app", bundleId: "com.example.installed", pid: null },
  ],
});
it("owns running versus installed application choices and never sends a command while discovering", async () => {
  const request = vi.fn(async () => response());
  const discover = systemDiscovery(createModuleHostServices(request));
  expect(
    (await discover(query("applications"), { signal })).choices.map(
      (x) => x.id,
    ),
  ).toEqual(["com.example.running"]);
  expect(
    (
      await discover(
        query("applications", { actionType: "open-application" }),
        { signal },
      )
    ).choices.map((x) => x.id),
  ).toEqual(["com.example.running", "com.example.installed"]);
  expect(
    (await discover(query("installed-applications"), { signal })).choices,
  ).toHaveLength(2);
  for (const [method, value] of request.mock.calls as unknown as [
    string,
    { input: { operation: string } },
  ][]) {
    expect(method).toBe("service");
    expect(value.input.operation).toBe("list-applications");
  }
});
it("supplies full menu sources as bounded atomic choices, rejects stale cursors and honours cancellation", async () => {
  const paths = Array.from({ length: 32 }, (_, i) => [
    { title: "File" },
    { title: `Long menu ${String(i)} ${"x".repeat(170)}` },
  ]);
  const request = vi.fn(async () => ({
    ...response(),
    menuCommands: paths.map((path) => ({ path, enabled: true })),
    menuCommandsTruncated: false,
  }));
  const discover = systemDiscovery(createModuleHostServices(request));
  const first = ModuleChoicePageSchema.parse(
    await discover(
      query("menu-commands", { applicationBundleId: "com.example.running" }),
      { signal },
    ),
  );
  expect(first.choices).toHaveLength(25);
  expect(first.choices[0]?.values?.menuPath).toBe(JSON.stringify(paths[0]));
  expect(first.choices[0]?.id.length).toBe(64);
  const secondQuery = {
    ...query("menu-commands", { applicationBundleId: "com.example.running" }),
    cursor: first.nextCursor,
    catalogRevision: first.revision,
  };
  expect((await discover(secondQuery, { signal })).choices).toHaveLength(7);
  expect(request).toHaveBeenCalledTimes(1);
  await expect(
    discover({ ...secondQuery, catalogRevision: "stale" }, { signal }),
  ).rejects.toThrow("changed");
  await expect(
    discover(query("applications"), { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
it("surfaces inaccessible or truncated native menus without executing them or substituting another application", async () => {
  const request = vi.fn(async () => ({
    ...response(),
    menuCommands: [],
    menuCommandsTruncated: true,
  }));
  const discover = systemDiscovery(createModuleHostServices(request));
  await expect(
    discover(
      query("menu-commands", { applicationBundleId: "com.example.running" }),
      { signal },
    ),
  ).rejects.toThrow("limit");
  const denied = systemDiscovery(
    createModuleHostServices(async () => ({
      ...response(),
      errorCode: "keyboard_permission_required",
      message: "Permission is required",
    })),
  );
  await expect(
    denied(
      query("menu-commands", { applicationBundleId: "com.example.running" }),
      { signal },
    ),
  ).rejects.toThrow("Permission");
});
it("maps all Matrix actions into the same validated public executor and keeps unused sources out of the request", async () => {
  const request = vi.fn(async () => ({
    ...response(),
    sent: true,
    completed: true,
  }));
  const context: ModuleContext = {
    instanceId: "fixture",
    scope: {
      kind: "host",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      capabilityId: "system-actions",
    },
    settings: {},
    services: createModuleHostServices(request),
    log() {},
    publishState() {},
    publishFeedback() {},
  };
  const instance = module.createInstance(context);
  const execution: ModuleExecutionContext = {
    executionId: "fixture",
    gesture: "press",
    wrap: false,
    signal,
    log() {},
  };
  await instance.start();
  try {
    for (const actionType of [
      "send-shortcut",
      "activate-application",
      "open-application",
      "select-menu-item",
    ]) {
      const values = {
        actionType,
        target: "global",
        applicationBundleId: "com.example.running",
        key: "KeyB",
        modifiers: "command",
        menuPath: JSON.stringify([{ title: "File" }, { title: "Open" }]),
      };
      expect(
        await instance.execute("matrix", { values }, execution),
      ).toMatchObject({ status: "success" });
    }
    expect(request).toHaveBeenCalledTimes(4);
    expect(matrix.fields.find((field) => field.id === "key")?.shortcut).toEqual(
      { modifiersField: "modifiers" },
    );
    expect(
      matrixAction({
        values: {
          actionType: "open-application",
          applicationBundleId: "com.example.running",
          key: "Unrelated",
        },
      }),
    ).toEqual({
      id: "system.open-application",
      fields: { applicationBundleId: "com.example.running" },
    });
    expect(
      await instance.execute(
        "matrix",
        { values: { actionType: "invalid" } },
        execution,
      ),
    ).toMatchObject({ status: "failure", category: "invalid-config" });
    expect(request).toHaveBeenCalledTimes(4);
  } finally {
    await instance.dispose();
  }
});

it("publishes friendly labels without replacing saved sources or pretending native actions have selected-state feedback", async () => {
  const { systemFeedback } = await import("../src/feedback.js");
  const subscription = {
    id: "matrix",
    fields: {
      values: {
        actionType: "select-menu-item",
        applicationBundleId: "com.example.running",
        menuPath: JSON.stringify([{ title: "File" }, { title: "Open" }]),
      },
    },
  };
  const result = systemFeedback(
    subscription,
    new Map([["com.example.running", "Running app"]]),
  );
  expect(ModuleFeedbackSchema.safeParse(result).success).toBe(true);
  expect(result).toMatchObject({
    state: "inactive",
    fields: subscription.fields,
    appearance: {
      cells: {
        applicationBundleId: { label: "Running app" },
        menuPath: { label: "File > Open" },
      },
    },
  });
  const invalid = systemFeedback(
    {
      id: "matrix",
      fields: {
        values: {
          actionType: "send-shortcut",
          key: "Bogus",
          modifiers: "unknown",
        },
      },
    },
    new Map(),
  );
  expect(invalid.appearance?.cells).toEqual({});
  expect(ModuleFeedbackSchema.safeParse(invalid).success).toBe(true);
});
