import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { RcpSession } from "../src/rcp-session.js";
import { CyanViewRcpConnectionDefinitionSchema } from "../src/config.js";
import { broker, closeBrokers } from "./loopback-broker.js";

const sessions: RcpSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.stop();
  await closeBrokers();
});

async function setup() {
  const network = await broker();
  const changed = vi.fn();
  const session = new RcpSession(
    CyanViewRcpConnectionDefinitionSchema.parse({
      type: "cyanview-rcp",
      connectionId: randomUUID(),
      name: "Loopback",
      host: "127.0.0.1",
      port: network.port,
      enabled: true,
      requestTimeoutMs: 1000,
      schemaVersion: 1,
    }),
    changed,
    true,
  );
  sessions.push(session);
  await expect.poll(() => session.snapshot().phase).toBe("ready");
  changed.mockClear();
  return { network, session, changed };
}

it("ignores unrelated and repeated camera status while preserving real observation changes", async () => {
  const { network, session, changed } = await setup();
  for (let index = 0; index < 100; index++) {
    network.send("unit/a/camhead/status/volatile/iris_position", String(index));
    network.send("unit/a/camhead/status/persist/number", "101");
    network.send("unit/a/camhead/status/persist/name", "Camera a");
    network.send("unit/a/camhead/status/volatile/control", "online");
  }
  network.send("unit/untracked/camhead/status/volatile/iris_position", "1");
  // A meaningful update on the same ordered socket is the processing barrier.
  network.send("unit/a/camhead/status/persist/name", "Renamed camera");
  await expect
    .poll(
      () =>
        session.cameraObservations().find(({ number }) => number === 101)?.name,
    )
    .toBe("Renamed camera");
  expect(changed).toHaveBeenCalledTimes(1);
  expect(session.cameraObservations()).toHaveLength(2);
  expect(session.captureCamera(101).observation.name).toBe("Renamed camera");
  expect(network.commands).toHaveLength(0);
});

it("preserves each live recording sequence even when the recording value repeats", async () => {
  const { network, session, changed } = await setup();
  const before = session.captureCamera(101).observation;
  expect(before.recording).toBe(false);
  expect(before.recordingSequence).toBe(0); // Initial retained report.
  network.send("unit/a/camhead/status/volatile/recording", "0");
  network.send("unit/a/camhead/status/volatile/recording", "0");
  await expect
    .poll(() => session.captureCamera(101).observation.recordingSequence)
    .toBe(2);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(session.captureCamera(101).observation.recording).toBe(false);
  expect(network.commands).toHaveLength(0);
});
