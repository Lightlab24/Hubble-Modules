import net from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import module from "../src/module.js";
import { packet31 } from "./fixtures/tsl-packets.js";
import type {
  ModuleContext,
  ModuleState,
  ModuleFeedback,
} from "@hubble/module-sdk";
describe("module-owned TSL observations", () => {
  it("exposes real Ross TCP traffic through the page, feedback and public data, clearing it on disconnect", async () => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const states: ModuleState[] = [],
      feedback: ModuleFeedback[] = [];
    const publish = vi.fn(async () => {});
    const context = {
      scope: {
        kind: "connection",
        workspaceId: randomUUID(),
        connectionId: randomUUID(),
      },
      instanceId: randomUUID(),
      settings: {
        name: "Ross tally",
        protocol: "3.1",
        transport: "tcp",
        bindAddress: "127.0.0.1",
        port,
        sourceAddress: "",
        staleAfterMs: 0,
        feedbackMappings: [
          {
            id: "camera-1",
            values: {
              name: "Camera 1",
              screen: 0,
              address: 1,
              indicator: "default",
            },
          },
        ],
      },
      publishState: (state: ModuleState) => states.push(state),
      publishFeedback: (value: ModuleFeedback) => feedback.push(value),
      publishEvent: vi.fn(),
      log: vi.fn(),
      modules: { publish },
    } as unknown as ModuleContext;
    const instance = module.createInstance(context);
    let socket: net.Socket | undefined;
    try {
      await instance.start();
      socket = net.connect(port, "127.0.0.1");
      await once(socket, "connect");
      socket.write(packet31(1, 2, "CAM 1"));
      await vi.waitFor(() =>
        expect(feedback.at(-1)).toMatchObject({
          id: "tally",
          fields: { mappingId: "camera-1" },
          state: "active",
        }),
      );
      expect(states.at(-1)?.values.discovery).toEqual([
        expect.objectContaining({
          values: expect.objectContaining({ label: "CAM 1", tally: "T2" }),
        }),
      ]);
      expect(
        await instance.queryData?.(
          { id: "tally", version: 1, input: null },
          { signal: new AbortController().signal },
        ),
      ).toMatchObject({
        phase: "listening",
        displays: [[0, 1, 2, 0, 0, 0, true, 1]],
      });
      expect(publish).toHaveBeenCalledWith(
        "tally",
        1,
        expect.objectContaining({ phase: "listening" }),
      );
      socket.end();
      await vi.waitFor(() =>
        expect(feedback.at(-1)?.state).toBe("unavailable"),
      );
    } finally {
      socket?.destroy();
      await instance.dispose();
    }
  });
});
