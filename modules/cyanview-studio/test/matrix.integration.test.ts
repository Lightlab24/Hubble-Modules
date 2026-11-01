import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  ModuleFeedbackSchema,
  moduleMatrixMatches,
  parseModuleMatrixValue,
  resolveModuleMatrix,
  type ModuleContext,
  type ModuleValues,
} from "@hubble/module-sdk";
import module from "../src/module.js";
import { matrix } from "../src/matrix.js";

it("leaves blank selectors unconfigured and retains validation for nonblank drafts", () => {
  for (const [command, selected, valid, invalid] of [
    ["select-feed-number", "feedNumber", 4, 0],
    ["select-feed-id", "feedId", -5, 0.5],
    ["select-feed", "cameraId", "Camera 1", "x".repeat(4097)],
  ] as const) {
    const field = matrix.fields.find((item) => item.id === selected)!;
    const values = { actionType: command, feedNumber: null, feedId: null, cameraId: null };
    expect(parseModuleMatrixValue(field, "")).toBe(field.type === "text" ? "" : null);
    expect(moduleMatrixMatches(matrix.inactiveWhen, values)).toBe(true);
    expect(moduleMatrixMatches(matrix.inactiveWhen, { ...values, [selected]: valid })).toBe(false);
    expect(parseModuleMatrixValue(field, valid)).toBe(valid);
    expect(() => parseModuleMatrixValue(field, invalid)).toThrow();
  }
});

it("runs all package-owned Matrix selectors against Studio without a host action adapter", async () => {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && url.pathname === "/api/openapi") {
      response.end(
        JSON.stringify({
          info: { version: "1.0.0" },
          paths: {
            "/api/control/feed": {
              post: {
                parameters: [
                  ["camera_id", "string"],
                  ["feed_number", "integer"],
                  ["feed_id", "integer"],
                ].map(([name, type]) => ({
                  name,
                  in: "query",
                  required: false,
                  schema: { type },
                })),
              },
            },
          },
        }),
      );
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/api/control/feed") {
      response.writeHead(404).end("{}");
      return;
    }
    requests.push(url);
    response.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");
  const publishState = vi.fn();
  const publishFeedback = vi.fn((value) => ModuleFeedbackSchema.parse(value));
  const context: ModuleContext = {
    instanceId: "cyan-matrix-test",
    scope: {
      kind: "connection",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    },
    settings: { host: "127.0.0.1", port: address.port, requestTimeoutMs: 1000 },
    log() {},
    publishEvent() {},
    publishState,
    publishFeedback,
  };
  const instance = module.createInstance(context);
  const execution = {
    executionId: "matrix-test",
    gesture: "press" as const,
    wrap: false,
    signal: new AbortController().signal,
    log() {},
  };
  try {
    await instance.start();
    await vi.waitFor(() =>
      expect(publishState).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "ready" }),
      ),
    );
    for (const [command, field, value] of [
      ["select-feed-number", "feedNumber", 4],
      ["select-feed-id", "feedId", -5],
      ["select-feed", "cameraId", "CAM / A+B?"],
    ] as const) {
      const resolved = resolveModuleMatrix(matrix, {
        "column.commandId": command,
      });
      expect(
        resolved.fields.find((item) => item.id === "actionType")?.default,
      ).toBe(command);
      expect(
        await instance.execute(
          "matrix",
          {
            values: {
              actionType: command,
              enabled: true,
              cameraId: "unused",
              feedId: 99,
              feedNumber: 99,
              [field]: value,
            },
          },
          execution,
        ),
      ).toMatchObject({ status: "success" });
    }
    expect(requests.map((url) => [...url.searchParams.entries()])).toEqual([
      [["feed_number", "4"]],
      [["feed_id", "-5"]],
      [["camera_id", "CAM / A+B?"]],
    ]);
    await instance.subscribeFeedback?.(
      [{ id: "matrix", fields: { actionId: "observe" } }],
      {
        signal: execution.signal,
      },
    );
    expect(publishFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix", state: "inactive" }),
    );
    expect(requests).toHaveLength(3);
    const invalid: ModuleValues[] = [
      { actionType: "select-feed-number", feedNumber: 0 },
      { actionType: "select-feed-id", feedId: 0.5 },
      { actionType: "select-feed", cameraId: "" },
      { actionType: "unknown" },
    ];
    for (const values of invalid)
      expect(
        await instance.execute("matrix", { values }, execution),
      ).toMatchObject({
        status: "failure",
        category: "invalid-config",
      });
    expect(requests).toHaveLength(3);
  } finally {
    await instance.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
