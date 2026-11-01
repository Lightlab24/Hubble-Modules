import { test, type TestContext } from "vitest";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import { ModuleStateSchema, type ModuleJsonValue } from "@hubble/module-sdk";
import module from "../src/index.js";
import manifest from "../src/manifest.js";
import { mqttText, packet } from "../src/mqtt-listener.js";

async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for capture");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(
  t: TestContext,
  options: { refuse?: boolean; fragment?: boolean } = {},
) {
  const connections = new Set<Socket>(),
    received: Buffer[] = [];
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    let input: Buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      input = Buffer.concat([input, data]);
      while (input.length >= 2) {
        let n = 0,
          mul = 1,
          offset = 1;
        for (;;) {
          const byte = input[offset];
          if (byte === undefined) return;
          offset++;
          n += (byte & 127) * mul;
          if (!(byte & 128)) break;
          mul *= 128;
        }
        if (input.length < offset + n) return;
        const message = Buffer.from(input.subarray(0, offset + n));
        input = input.subarray(offset + n);
        received.push(message);
        if (message[0] === 0x10)
          socket.write(packet(0x20, Buffer.from([0, options.refuse ? 5 : 0])));
        if (message[0] === 0x82) {
          const initial = Buffer.concat([
            packet(0x90, Buffer.from([0, 1, 0, 0])),
            packet(
              0x31,
              Buffer.concat([
                mqttText("rcp/camera/camhead/status/persist/number"),
                Buffer.from("2"),
              ]),
            ),
            packet(
              0x31,
              Buffer.concat([
                mqttText("rcp/camera/camhead/status/persist/gain_mode"),
                Buffer.from("ISO800"),
              ]),
            ),
          ]);
          if (options.fragment) {
            socket.write(initial.subarray(0, 3));
            setTimeout(() => socket.write(initial.subarray(3)), 10);
          } else socket.write(initial);
        }
        if (message[0] === 0xc0) socket.write(packet(0xd0));
        if (message[0] === 0xe0) socket.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(path.join(tmpdir(), "mqtt-capture-test-"));
  const h = createModuleHarness(module);
  Object.assign(h.context, { runtimeDirectory: directory });
  const state = () => ModuleStateSchema.parse(h.states.at(-1));
  const call = async (
    commandId: string,
    fields: Record<string, ModuleJsonValue> = {},
    cursor: string | null = null,
  ) =>
    h.instance.call!(
      "page.capture",
      { sectionId: "captureControls", commandId, fields, cursor },
      h.execution(),
    );
  t.onTestFinished(async () => {
    await h.instance.dispose();
    for (const socket of connections) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await h.instance.start();
  return {
    h,
    state,
    call,
    directory,
    received,
    port: address.port,
    connections,
  };
}

test("captures retained/live/binary messages, notes and exact chunked export without publishing; restores stopped capture", async (t) => {
  const f = await fixture(t, { fragment: true });
  assert.equal(f.received.length, 0, "opening the module must not connect");
  await f.call("start", { host: "127.0.0.1", port: f.port });
  await waitFor(() => f.state().values.messages === 2);
  await f.call("marker", { note: "Pressed Gain Up" });
  const socket = [...f.connections][0];
  socket.write(
    packet(
      0x30,
      Buffer.concat([
        mqttText("rcp/camera/camhead/action/next/gain_mode"),
        Buffer.alloc(0),
      ]),
    ),
  );
  socket.write(
    packet(
      0x30,
      Buffer.concat([mqttText("binary"), Buffer.from([0xff, 0x00, 0xfe])]),
    ),
  );
  const long = "\uFEFF" + "📷".repeat(40_000);
  socket.write(
    packet(0x30, Buffer.concat([mqttText("long"), Buffer.from(long)])),
  );
  await waitFor(() => f.state().values.messages === 5);
  await f.call("stop");
  let cursor: string | null = null,
    text = "",
    chunks = 0;
  do {
    const result = (await f.call("export", {}, cursor)) as {
      text: string;
      nextCursor: string | null;
    };
    text += result.text;
    cursor = result.nextCursor;
    chunks++;
  } while (cursor);
  assert(chunks > 1);
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((r) => r.type === "message").length, 5);
  assert.equal(records.find((r) => r.topic === "long").payload, long);
  assert.equal(records.find((r) => r.topic === "binary").payload, "/wD+");
  assert.equal(
    records.find((r) => r.type === "marker").note,
    "Pressed Gain Up",
  );
  assert.equal(f.state().values.retained, 2);
  assert.equal(f.state().values.live, 3);
  assert(
    f.received.every((p) => [0x10, 0x82, 0xc0, 0xe0].includes(p[0])),
    "capture sent a device command",
  );
  const files = await readdir(f.directory);
  assert.equal(await readFile(path.join(f.directory, files[0]), "utf8"), text);
  await f.h.instance.dispose();
  await f.h.instance.dispose();
  const restored = createModuleHarness(module);
  Object.assign(restored.context, { runtimeDirectory: f.directory });
  await restored.instance.start();
  assert.equal(
    ModuleStateSchema.parse(restored.states.at(-1)).values.messages,
    5,
  );
  assert.equal(
    ModuleStateSchema.parse(restored.states.at(-1)).values.canStop,
    false,
  );
  await restored.instance.dispose();
});

test("reports a refused connection and preserves its diagnostic transcript", async (t) => {
  const f = await fixture(t, { refuse: true });
  await f.call("start", { host: "127.0.0.1", port: f.port });
  await waitFor(() => f.state().phase === "error");
  assert.match(f.state().message!, /refused anonymous access/);
  assert.equal(f.state().values.canExport, true);
  assert.match(
    String(((await f.call("copy")) as { text: string }).text),
    /CONNACK 5/,
  );
});

test("cancellation, invalid targets, duplicate start, abrupt disconnect and repeated disposal never publish or reconnect", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    async () =>
      f.h.instance.call!(
        "page.capture",
        {
          sectionId: "captureControls",
          commandId: "start",
          fields: { host: "127.0.0.1", port: f.port },
        },
        f.h.execution(AbortSignal.abort()),
      ),
    /cancelled/,
  );
  await assert.rejects(
    () => f.call("start", { host: "http://127.0.0.1", port: 1883 }),
    /IP/,
  );
  await f.call("start", { host: "127.0.0.1", port: f.port });
  await assert.rejects(
    () => f.call("start", { host: "127.0.0.1", port: f.port }),
    /Stop/,
  );
  await waitFor(() => f.state().values.messages === 2);
  for (const socket of f.connections) socket.destroy();
  await waitFor(() => f.state().phase === "error");
  assert.equal(f.state().values.messages, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.received.filter((p) => p[0] === 0x10).length, 1);
});

test("keeps capture evidence local and rejects oversized packets without pretending the capture is complete", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(manifest.settings, []);
  assert.deepEqual(manifest.actions, []);
  assert.deepEqual(manifest.feedback, []);
  await f.call("start", { host: "127.0.0.1", port: f.port });
  await waitFor(() => f.state().values.messages === 2);
  const socket = [...f.connections][0];
  // Remaining length declares >1 MiB, without sending or allocating that payload.
  socket.write(Buffer.from([0x30, 0x81, 0x80, 0x40]));
  await waitFor(() => f.state().phase === "error");
  const result = (await f.call("export")) as { text: string };
  const records = result.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.filter((r) => r.type === "message").length, 2);
  assert.equal(records.at(-1).incomplete, true);
  assert.match(records.at(-1).reason, /1 MB/);
  assert.equal(f.state().values.canExport, true);
});
