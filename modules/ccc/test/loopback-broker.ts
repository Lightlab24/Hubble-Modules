import { createServer, type Socket } from "node:net";
import { once } from "node:events";
const cleanups: (() => Promise<void>)[] = [];
export async function closeBrokers(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

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
export async function broker() {
  const sockets = new Set<Socket>();
  const commands: { topic: string; value: string; header: number }[] = [];
  const recordings = new Map<string, string>();
  const controls = {
    acknowledge: true,
    feedback: true,
    retainedFeedback: false,
    ignoredCamera: "",
    ackDelay: 0,
    initialRecording: "0" as string | null,
    variableNd: false,
    capabilities: true,
  };
  let connections = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const send = (topic: string, value: string, retained = false) => {
    if (topic.endsWith("/recording")) recordings.set(topic, value);
    for (const socket of sockets) socket.write(publish(topic, value, retained));
  };
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
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
        if (header === 0x10) socket.write(Buffer.from([0x20, 2, 0, 0]));
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
          socket.write(
            publish(
              "unit/RCP/rcp_helper/status/volatile/control",
              "online",
              true,
            ),
          );
          for (const [id, number] of [
            ["a", "101"],
            ["b", "102"],
          ] as const) {
            socket.write(
              publish(`unit/${id}/camhead/status/persist/number`, number, true),
            );
            socket.write(
              publish(
                `unit/${id}/camhead/status/persist/name`,
                `Camera ${id}`,
                true,
              ),
            );
            socket.write(
              publish(
                `unit/${id}/camhead/status/volatile/control`,
                "online",
                true,
              ),
            );
            if (controls.capabilities)
              socket.write(
                publish(
                  `unit/${id}/camhead/status/volatile/capabilities`,
                  "00 ".repeat(13) + (id === "a" ? "80" : "00"),
                  true,
                ),
              );
            if (controls.variableNd)
              socket.write(
                publish(
                  `unit/${id}/camhead/status/persist/nd_filter_clear`,
                  "0",
                  true,
                ),
              );
            if (controls.initialRecording !== null) {
              const recordingTopic = `unit/${id}/camhead/status/volatile/recording`;
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
          if (controls.feedback)
            socket.write(
              publish(recordingTopic, recording, controls.retainedFeedback),
            );
        } else if (header === 0xc0) socket.write(Buffer.from([0xd0, 0]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing broker address");
  cleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return {
    port: address.port,
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
  };
}
