import type { Duplex } from 'node:stream';

/**
 * The MQTT broker a Cyanview controller runs, as far as the module uses it: camera status under
 * `<root>/<camera>/camhead/status/...`, the RCP panel under `<root>/RCP/...`, and the commands a key press
 * publishes. Connections come from outside as streams, so it opens nothing itself: the simulated rig hands it
 * in-memory ones, and the module's tests a loopback TCP server's.
 *
 * With no `model` it reports two cameras, `a` and `b`, numbered 1 and 2, under `controls.root`, and `controls`
 * changes how it answers. With a model, the cameras, recording and selected camera are the simulated
 * controller's own, and `refresh()` reports whatever has changed since.
 */
export type BrokerCamera = { id: string; number: string; name: string; online: boolean | null; recording: '0' | '1'; model?: string };
export interface BrokerModel {
  /** The topic root, the controller's serial in lower case. */
  root(): string;
  /** Whether an RCP panel reports on this controller, which Select camera needs. */
  panel(): boolean;
  cameras(): BrokerCamera[];
  /** A Rec, Stop or RecToggle press on one camera. The model applies it and reports it with `refresh()`. */
  record(id: string, value: 'Rec' | 'Stop' | 'RecToggle'): void;
  /** The camera the panel has selected, or null. */
  selected(): string | null;
  /** A Select camera press. The model selects the camera with that number, if it has one. */
  select(number: string): void;
}
type Stream = Pick<Duplex, 'write' | 'destroy' | 'on'> & { setNoDelay?(noDelay?: boolean): unknown };

function packet(header: number, body: Buffer): Buffer {
  let length = body.length;
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length) byte |= 128;
    bytes.push(byte);
  } while (length);
  return Buffer.concat([Buffer.from([header, ...bytes]), body]);
}
function publish(topic: string, value: string, retained = false) {
  const text = Buffer.from(topic);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length);
  return packet(
    retained ? 0x31 : 0x30,
    Buffer.concat([length, text, Buffer.from(value)]),
  );
}
const CAPABILITIES = (recStop: boolean) => "00 ".repeat(13) + (recStop ? "80" : "00");

export function createBroker(options: { onlyHubble?: boolean; model?: BrokerModel } = {}) {
  const { model } = options;
  const sockets = new Set<Stream>();
  const subscribed = new Set<Stream>();
  const commands: { topic: string; value: string; header: number }[] = [];
  const recordings = new Map<string, string>();
  const controls = {
    panel: true,
    acknowledge: true,
    feedback: true,
    feedbackDelay: 0,
    retainedFeedback: false,
    ignoredCamera: "",
    ackDelay: 0,
    initialRecording: "0" as string | null,
    variableNd: false,
    // A camera answers an ND in/out command with its new state, as camera 1 did on RCP 1.
    ndFeedback: true,
    // Each camera's colour temperature and tint, moved by `action/add/wb_*` and reported back, as camera 1 did on RCP 1.
    wb: {} as Record<string, { temp: number; tint: number | null }>,
    wbFeedback: true,
    capabilities: true,
    silent: false,
    root: "unit",
    // Cameras listed with no connection report, as the RCP holds them while their RIO is off the network.
    unreported: [] as string[],
  };
  let connections = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = (topic: string, value: string, retained = false) => {
    if (topic.endsWith("/recording")) recordings.set(topic, value);
    for (const socket of sockets) socket.write(publish(topic, value, retained));
  };
  // What a model's controller reports now, topic by topic, retained as a real broker keeps it.
  const reported = new Map<string, string>();
  const modelTopics = () => {
    const topics = new Map<string, string>(), root = model!.root();
    if (model!.panel()) {
      topics.set(`${root}/RCP/rcp_helper/status/volatile/control`, "online");
      const selected = model!.selected();
      if (selected) topics.set(`${root}/RCP/rcp/status/volatile/active_camera`, selected);
    }
    for (const camera of model!.cameras()) {
      const base = `${root}/${camera.id}/camhead/status`;
      topics.set(`${base}/persist/number`, camera.number);
      topics.set(`${base}/persist/name`, camera.name);
      if (camera.model) topics.set(`${base}/persist/model`, camera.model);
      if (camera.online !== null) topics.set(`${base}/volatile/control`, camera.online ? "online" : "offline");
      topics.set(`${base}/volatile/capabilities`, CAPABILITIES(true));
      // Only a camera that is online reports whether it is recording.
      if (camera.online) topics.set(`${base}/volatile/recording`, camera.recording);
    }
    return topics;
  };
  /**
   * Reports what has changed on the model's controller to everyone subscribed, and clears a camera that has gone. As
   * on a real broker, a change reaches a listener as a live message and only what it is sent on subscribing is retained.
   */
  const refresh = () => {
    if (!model) return;
    const now = modelTopics();
    for (const [topic, value] of now) if (reported.get(topic) !== value) for (const socket of subscribed) socket.write(publish(topic, value));
    for (const topic of reported.keys()) if (!now.has(topic) && /\/(number|control|active_camera)$/u.test(topic)) for (const socket of subscribed) socket.write(publish(topic, ""));
    reported.clear();
    for (const [topic, value] of now) reported.set(topic, value);
  };
  const accept = (socket: Stream) => {
    connections += 1;
    // Nagle's algorithm can hold a small report back behind an unacknowledged packet. On Linux that
    // outlasts the 20 ms a test waits after a report, so the report looks as if it never arrived.
    socket.setNoDelay?.(true);
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => { sockets.delete(socket); subscribed.delete(socket); });
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        let length = 0;
        let offset = 1;
        let multiplier = 1;
        for (;;) {
          const byte = buffer[offset];
          if (byte === undefined) return;
          offset += 1;
          length += (byte & 127) * multiplier;
          multiplier *= 128;
          if (!(byte & 128)) break;
        }
        if (buffer.length < offset + length) return;
        const header = buffer.readUInt8(0);
        const body = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (header === 0x10) {
          // On the real port, another app on this machine must not be fed fake cameras. CyanView Studio connects to any broker it finds there.
          if (options.onlyHubble && !body.includes("hubble-")) {
            socket.destroy();
            return;
          }
          if (!controls.silent) socket.write(Buffer.from([0x20, 2, 0, 0]));
        }
        else if (header === 0x82) {
          let count = 0;
          for (let index = 2; index < body.length; count += 1)
            index += body.readUInt16BE(index) + 3;
          socket.write(
            packet(
              0x90,
              Buffer.concat([body.subarray(0, 2), Buffer.alloc(count)]),
            ),
          );
          if (model) {
            // Anyone already listening hears what changed first, so everyone holds the same retained values.
            refresh();
            subscribed.add(socket);
            for (const [topic, value] of reported) socket.write(publish(topic, value, true));
            continue;
          }
          if (controls.panel) socket.write(
            publish(
              `${controls.root}/RCP/rcp_helper/status/volatile/control`,
              "online",
              true,
            ),
          );
          for (const [id, number] of [
            ["a", "1"],
            ["b", "2"],
          ] as const) {
            socket.write(
              publish(`${controls.root}/${id}/camhead/status/persist/number`, number, true),
            );
            socket.write(
              publish(
                `${controls.root}/${id}/camhead/status/persist/name`,
                `Camera ${id}`,
                true,
              ),
            );
            if (!controls.unreported.includes(id))
              socket.write(
                publish(
                  `${controls.root}/${id}/camhead/status/volatile/control`,
                  "online",
                  true,
                ),
              );
            if (controls.capabilities)
              socket.write(
                publish(
                  `${controls.root}/${id}/camhead/status/volatile/capabilities`,
                  CAPABILITIES(id === "a"),
                  true,
                ),
              );
            if (controls.variableNd)
              socket.write(
                publish(
                  `${controls.root}/${id}/camhead/status/persist/nd_filter_clear`,
                  "0",
                  true,
                ),
              );
            if (controls.initialRecording !== null) {
              const recordingTopic = `${controls.root}/${id}/camhead/status/volatile/recording`;
              recordings.set(recordingTopic, controls.initialRecording);
              socket.write(
                publish(recordingTopic, controls.initialRecording, true),
              );
            }
          }
        } else if (header >> 4 === 3) {
          const size = body.readUInt16BE(0);
          const topic = body.subarray(2, size + 2).toString();
          const value = body.subarray(size + 4).toString();
          commands.push({ topic, value, header });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (
            controls.acknowledge &&
            !topic.includes(`/${controls.ignoredCamera}/`)
          ) {
            const acknowledge = () => {
              inFlight -= 1;
              socket.write(packet(0x40, body.subarray(size + 2, size + 4)));
            };
            if (controls.ackDelay)
              timers.push(setTimeout(acknowledge, controls.ackDelay));
            else acknowledge();
          }
          if (model) {
            // The simulated controller applies a press and reports it, as camera status, to everyone listening.
            const root = model.root();
            const recording = new RegExp(`^${root}/([^/]+)/camhead/action/set/keyboard$`, "u").exec(topic);
            if (recording && ["Rec", "Stop", "RecToggle"].includes(value)) model.record(recording[1]!, value as "Rec" | "Stop" | "RecToggle");
            else if (topic === `${root}/RCP/rcp/action/set/active_camera_number`) model.select(value);
            continue;
          }
          const wb = /\/([^/]+)\/camhead\/action\/add\/(wb_temp|wb_tint)$/u.exec(topic);
          if (wb) {
            const camera = controls.wb[wb[1]!];
            if (camera && controls.wbFeedback) {
              if (wb[2] === "wb_temp") camera.temp += Number(value);
              else if (camera.tint !== null) camera.tint = Math.max(-0.99, Math.min(0.99, Math.round((camera.tint + Number(value)) * 100) / 100));
              const reported = wb[2] === "wb_temp" ? String(camera.temp) : String(camera.tint);
              send(topic.replace(/action\/add\/wb_(temp|tint)$/u, `status/volatile/${wb[2]}`), reported);
            }
            continue;
          }
          if (topic.endsWith("/action/set/nd_filter_clear")) {
            if (controls.ndFeedback && ["0", "1"].includes(value)) {
              const report = () => send(topic.replace("/action/set/", "/status/volatile/"), value);
              if (controls.feedbackDelay) timers.push(setTimeout(report, controls.feedbackDelay));
              else report();
            }
            continue;
          }
          if (
            !topic.endsWith("/action/set/keyboard") ||
            !["Rec", "Stop", "RecToggle"].includes(value)
          )
            continue;
          const recordingTopic = topic.replace(
            "action/set/keyboard",
            "status/volatile/recording",
          );
          const recording =
            value === "Rec" ||
            (value === "RecToggle" && recordings.get(recordingTopic) !== "1")
              ? "1"
              : "0";
          recordings.set(recordingTopic, recording);
          if (controls.feedback) {
            // A real broker tells every subscriber, and a test can have more than one.
            const feedback = () =>
              send(recordingTopic, recording, controls.retainedFeedback);
            if (controls.feedbackDelay)
              timers.push(setTimeout(feedback, controls.feedbackDelay));
            else feedback();
          }
        } else if (header === 0xc0) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  };
  return {
    accept,
    refresh,
    resetMaxInFlight() {
      maxInFlight = inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    commands,
    controls,
    send,
    get connections() {
      return connections;
    },
    disconnect() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
    },
  };
}
export type Broker = ReturnType<typeof createBroker>;
