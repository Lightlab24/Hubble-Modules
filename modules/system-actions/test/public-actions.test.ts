import { expect, it, vi } from "vitest";
import type { ModuleContext, ModuleExecutionContext } from "@hubble/module-sdk";
import { unavailableKeyboardBridgeResponse } from "@hubble/module-contracts/keyboard";
import module from "../src/module.js";
import manifest from "../src/manifest.js";

it("owns public action fields and executes generic actions through the injected bridge only", async () => {
  const requestHost = vi.fn(async () => ({
    ...unavailableKeyboardBridgeResponse(),
    available: true,
    permissionGranted: true,
    sent: true,
    completed: true,
    errorCode: null,
    message: null,
  }));
  const context: ModuleContext = {
    instanceId: "fixture",
    scope: {
      kind: "host",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      capabilityId: "system-actions",
    },
    settings: {},
    requestHost,
    log() {},
    publishState() {},
    publishFeedback() {},
  };
  const instance = module.createInstance(context);
  await instance.start();
  const execution: ModuleExecutionContext = {
    executionId: "fixture",
    gesture: "press",
    wrap: false,
    signal: new AbortController().signal,
    log() {},
  };
  const cases = [
    [
      "keyboard.send-shortcut",
      {
        target: "global",
        applicationBundleId: "",
        key: "KeyA",
        modifiers: "command+shift",
      },
    ],
    [
      "system.activate-application",
      { applicationBundleId: "com.fixture.test" },
    ],
    ["system.open-application", { applicationBundleId: "com.fixture.test" }],
    [
      "system.select-menu-item",
      { applicationBundleId: "com.fixture.test", menuPath: "File > Open" },
    ],
  ] as const;
  try {
    for (const [id, fields] of cases) {
      expect(
        manifest.actions.find((action) => action.id === id)?.fields.length,
      ).toBeGreaterThan(0);
      expect(
        manifest.actions.find((action) => action.id === id),
      ).not.toHaveProperty("legacy", true);
      await expect(
        instance.execute(id, fields, execution),
      ).resolves.toMatchObject({ status: "success" });
    }
    expect(requestHost).toHaveBeenCalledTimes(4);
    expect(requestHost.mock.calls.at(-1)).toMatchObject([
      "keyboard",
      {
        operation: "select-menu-item",
        menuPath: [{ title: "File" }, { title: "Open" }],
      },
    ]);
  } finally {
    await instance.dispose();
  }
});
