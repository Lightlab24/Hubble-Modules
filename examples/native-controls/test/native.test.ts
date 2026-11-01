import { expect, it, vi } from "vitest";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import { createModuleHostServices } from "@hubble/module-sdk";
import module from "../src/index.js";
it("discovers without executing and uses only the injected native API for an explicit action", async () => {
  const request = vi.fn(async (_method: string, _input: unknown) => ({
    available: true,
    permissionGranted: true,
    applications: [
      { bundleId: "com.example.inert", name: "Inert fixture", pid: 5 },
    ],
    sent: true,
    errorCode: null,
    message: null,
  }));
  const harness = createModuleHarness(
    module,
    {},
    {
      scope: {
        kind: "host",
        workspaceId: "11111111-1111-4111-8111-111111111111",
        capabilityId: "example-native-controls",
      },
      services: createModuleHostServices(request),
    },
  );
  await harness.instance.start();
  expect(request).not.toHaveBeenCalled();
  const execution = harness.execution();
  await harness.instance.subscribeFeedback!(
    [{ id: "matrix", fields: { values: { "module.chord": "KeyK" } } }],
    { signal: execution.signal },
  );
  expect(harness.feedback).toEqual([
    expect.objectContaining({
      state: "inactive",
      observedAt: expect.any(String),
    }),
  ]);
  expect(request).not.toHaveBeenCalled();
  const choices = await harness.instance.discoverChoices!(
    {
      version: 2,
      provider: "applications",
      draft: {},
      search: "",
      cursor: null,
      limit: 10,
      requestRevision: 1,
    },
    { signal: execution.signal },
  );
  expect(choices.choices[0]?.label).toBe("Inert fixture");
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    input: { operation: "list-applications" },
  });
  expect(
    await harness.instance.execute(
      "send",
      {
        values: {
          "module.chord": "KeyK",
          "module.modifiers": "command+shift",
          "module.application": "com.example.inert",
        },
      },
      execution,
    ),
  ).toMatchObject({ status: "success", evidence: { kind: "response" } });
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    input: {
      operation: "send-shortcut",
      key: "KeyK",
      modifiers: ["command", "shift"],
      target: { mode: "application", bundleId: "com.example.inert" },
    },
  });
  await harness.instance.dispose();
});
