import assert from "node:assert/strict";
import { it, mock } from "node:test";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import {
  createModuleHostServices,
  type NativeMenuRequest,
} from "@hubble/module-sdk";
import module from "../src/index.js";
it("pages through the generic API and invokes once with the discovered process precondition", async () => {
  const cursor = "12345678-1234-1234-1234-123456789abc:1";
  const request = mock.fn(async (_method: string, value: unknown) => {
    const { service, input } = value as {
      service: string;
      input: NativeMenuRequest;
    };
    assert.equal(service, "native-menus");
    return {
      available: true,
      permissionGranted: true,
      application: {
        bundleId: "com.example.viewer",
        executableName: "Studio Viewer",
        version: "1",
        pid: 42,
      },
      items:
        input.method === "read"
          ? [
              {
                path: [
                  { title: "View" },
                  { title: "Cameras" },
                  { title: input.cursor ? "Camera A" : "Camera B" },
                ],
                enabled: true,
              },
            ]
          : [],
      nextCursor: input.method === "read" && !input.cursor ? cursor : null,
      completed: input.method === "select",
      errorCode: null,
      message: null,
    };
  });
  const harness = createModuleHarness(
    module,
    {},
    { services: createModuleHostServices(request) },
  );
  await harness.instance.start();
  assert.equal(request.mock.callCount(), 0);
  assert.partialDeepStrictEqual(
    await harness.instance.execute(
      "choose-view",
      { title: "Camera A" },
      harness.execution(),
    ),
    {
      status: "success",
      evidence: { kind: "response" },
    },
  );
  assert.equal(request.mock.callCount(), 3);
  assert.partialDeepStrictEqual(request.mock.calls[2]?.arguments?.[1], {
    input: {
      method: "select",
      expectedProcessId: 42,
      preserveBackgroundFocus: true,
      path: [{ title: "View" }, { title: "Cameras" }, { title: "Camera A" }],
    },
  });
  await harness.instance.dispose();
});
