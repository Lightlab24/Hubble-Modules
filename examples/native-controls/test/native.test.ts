import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import { createModuleHostServices } from "@hubble/module-sdk";
import module from "../src/index.js";
it("discovers without executing and uses only the injected native API for an explicit action", async () => {
  const request = mock.fn(async (_method: string, _input: unknown) => ({
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
  assert.equal(request.mock.callCount(), 0);
  const execution = harness.execution();
  await harness.instance.subscribeFeedback!(
    [{ id: "matrix", fields: { values: { "module.chord": "KeyK" } } }],
    { signal: execution.signal },
  );
  assert.equal(harness.feedback.length, 1);
  assert.partialDeepStrictEqual(harness.feedback, [
    {
      state: "inactive",
    },
  ]);
  assert.equal(
    typeof (
      harness.feedback[0] as {
        observedAt: string;
      }
    ).observedAt,
    "string",
  );
  assert.equal(request.mock.callCount(), 0);
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
  assert.equal(choices.choices[0]?.label, "Inert fixture");
  assert.partialDeepStrictEqual(request.mock.calls[0]?.arguments?.[1], {
    input: { operation: "list-applications" },
  });
  assert.partialDeepStrictEqual(
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
    { status: "success", evidence: { kind: "response" } },
  );
  assert.partialDeepStrictEqual(request.mock.calls[1]?.arguments?.[1], {
    input: {
      operation: "send-shortcut",
      key: "KeyK",
      modifiers: ["command", "shift"],
      target: { mode: "application", bundleId: "com.example.inert" },
    },
  });
  await harness.instance.dispose();
});
