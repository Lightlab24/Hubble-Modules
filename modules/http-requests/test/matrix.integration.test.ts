import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import {
  ModuleFeedbackSchema,
  resolveModuleMatrix,
  type ModuleContext,
  type ModuleInstance,
} from "@hubble/module-sdk";
import module from "../src/module.js";
import { matrix } from "../src/matrix.js";
import { resourceFixture } from "./resource-fixture.js";

it("executes every Matrix method with its body and headers using the public module alone", async () => {
  const received: { method: string; body: string; marker?: string }[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        method: request.method ?? "",
        body,
        marker: request.headers["x-module"] as string,
      });
      response.end("accepted");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture listener");
  const publishFeedback = vi.fn((value) => ModuleFeedbackSchema.parse(value));
  const resources = resourceFixture();
  const context: ModuleContext = {
    instanceId: "matrix-test",
    services: resources.services,
    scope: {
      kind: "connection",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      connectionId: "22222222-2222-4222-8222-222222222222",
    },
    settings: {
      name: "Fixture",
      baseUrl: `http://127.0.0.1:${address.port}`,
      targetScope: "loopback",
      requestTimeoutMs: 1000,
    },
    log() {},
    publishState() {},
    publishFeedback,
  };
  const instance: ModuleInstance = module.createInstance(context);
  const execution = {
    executionId: "matrix-test",
    gesture: "press" as const,
    wrap: false,
    signal: new AbortController().signal,
    log() {},
  };
  try {
    await instance.start();
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const resolved = resolveModuleMatrix(matrix, {
        "column.commandId": method,
      });
      expect(
        resolved.fields.find((field) => field.id === "actionType")?.default,
      ).toBe(method);
      const result = await instance.execute(
        "matrix",
        {
          actionId: `row-${method}`,
          actionColumnId: "33333333-3333-4333-8333-333333333333",
          values: {
            enabled: true,
            actionType: method,
            requestTarget: "/test",
            header: '{"X-Module":"public"}',
            body: '{"camera":2}',
            contenttype: "application/json",
          },
        },
        execution,
      );
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "success",
      });
    }
    expect(received).toEqual(
      ["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => ({
        method,
        body: method === "GET" ? "" : '{"camera":2}',
        marker: "public",
      })),
    );
    expect(resources.requests).toHaveLength(10);
    expect(resources.requests[0]).toMatchObject({
      method: "acquire",
      claims: [
        { key: "requests", limit: 32 },
        { key: `origin:http://127.0.0.1:${address.port}`, limit: 4 },
      ],
    });
    resources.deny();
    expect(
      await instance.execute(
        "matrix",
        { values: { actionType: "get", requestTarget: "/denied" } },
        execution,
      ),
    ).toMatchObject({
      status: "failure",
      code: "generic_http_capacity_exceeded",
    });
    expect(received).toHaveLength(5);
    const count = received.length;
    await instance.subscribeFeedback?.(
      [{ id: "matrix", fields: { actionId: "observe" } }],
      {
        signal: execution.signal,
      },
    );
    expect(received).toHaveLength(count);
    expect(publishFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ id: "matrix", state: "inactive" }),
    );
    await expect(
      instance.execute(
        "matrix",
        { values: { actionType: "unsupported" } },
        execution,
      ),
    ).resolves.toMatchObject({ status: "failure", category: "invalid-config" });
    expect(received).toHaveLength(count);
  } finally {
    await instance.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
