import { createServer } from "node:http";
import { expect, it } from "vitest";
import type { ModuleContext } from "@hubble/module-sdk";
import module from "../src/module.js";
import manifest from "../src/manifest.js";

it("executes a public HTTP action using module-owned defaults against loopback only", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end("fixture");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test listener");
  const context: ModuleContext = {
    instanceId: "fixture",
    scope: {
      kind: "connection",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    },
    settings: {
      baseUrl: `http://127.0.0.1:${address.port}`,
      targetScope: "loopback",
      requestTimeoutMs: 1000,
    },
    log() {},
    publishState() {},
    publishFeedback() {},
  };
  const instance = module.createInstance(context);
  try {
    await instance.start();
    expect(
      manifest.actions.every(
        (action) => !("legacy" in action && action.legacy),
      ),
    ).toBe(true);
    const result = await instance.execute(
      "generic-http.get",
      { requestTarget: "/module-owned", header: "" },
      {
        executionId: "fixture",
        gesture: "press",
        wrap: false,
        signal: new AbortController().signal,
        log() {},
      },
    );
    expect(result).toMatchObject({ status: "success" });
    expect(requests).toEqual(["/module-owned"]);
  } finally {
    await instance.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
