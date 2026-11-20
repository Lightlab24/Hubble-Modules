import net from "node:net";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { TslPacketError, TslStreamDecoder } from "../src/protocol.js";
import { TslReceiver } from "../src/receiver.js";
import { packet50, stream50 } from "./fixtures/tsl-packets.js";

// The first bytes a Carbonite Ultra (software 9.2.1) sent over TCP for TSL 5.0, as received.
const BARE = Buffer.from("0b0000000000010040000100310b000000000002004000010032", "hex");
const WRAPPED = Buffer.from("fe020b000000000001004000010031fe020b000000000002004000010032", "hex");
const firstTwo = [
  expect.objectContaining({ protocol: "5.0", screen: 0, address: 1, label: "1", left: 0, text: 0, right: 0, brightness: 1 }),
  expect.objectContaining({ protocol: "5.0", screen: 0, address: 2, label: "2", brightness: 1 }),
];

describe("TSL 5.0 over TCP", () => {
  it("reads the bare packets a Ross switcher sends with its TSL header option off", () => {
    expect(new TslStreamDecoder("5.0").push(BARE)).toEqual(firstTwo);
    // The same bytes arriving one at a time.
    const decoder = new TslStreamDecoder("5.0");
    expect([...BARE].flatMap((byte) => [...decoder.push(Buffer.from([byte]))])).toEqual(firstTwo);
  });

  it("reads the wrapped packets it sends with the option on", () => {
    expect(new TslStreamDecoder("5.0").push(WRAPPED)).toEqual(firstTwo);
    const decoder = new TslStreamDecoder("5.0");
    expect([...WRAPPED].flatMap((byte) => [...decoder.push(Buffer.from([byte]))])).toEqual(firstTwo);
  });

  it("keeps to the framing a connection opened with", () => {
    // A bare packet for address 254 carries FE bytes, which only mean something when wrapped.
    const bare = new TslStreamDecoder("5.0");
    const packet = packet50(3, [{ address: 254, control: 4, label: "CAM" }]);
    expect(bare.push(Buffer.concat([BARE, packet]))).toEqual([
      ...firstTwo,
      expect.objectContaining({ screen: 3, address: 254, text: 1, label: "CAM" }),
    ]);
    // A wrapped stream ignores stray bytes between packets, as before.
    const wrapped = new TslStreamDecoder("5.0");
    expect(wrapped.push(Buffer.concat([stream50(packet), Buffer.from([1, 2, 3]), stream50(packet)]))).toHaveLength(2);
  });

  it("counts a bare byte count it cannot use as an invalid packet and carries on", () => {
    const errors: TslPacketError[] = [];
    const decoder = new TslStreamDecoder("5.0");
    const displays = decoder.push(Buffer.concat([Buffer.from([0x00, 0x00]), BARE]), (error) => errors.push(error));
    expect(errors.map((error) => error.message)).toEqual(["Invalid TSL 5.0 stream byte count"]);
    expect(displays).toEqual(firstTwo);
  });

  it("shows tally from a bare TCP stream through the receiver", async () => {
    const receiver = new TslReceiver(
      { protocol: "5.0", transport: "tcp", bindAddress: "127.0.0.1", port: 0, sourceAddress: "", staleAfterMs: 0 },
      () => undefined,
    );
    await receiver.start();
    const socket = net.connect(receiver.boundPort ?? 0, "127.0.0.1");
    try {
      await once(socket, "connect");
      socket.write(Buffer.concat([BARE, packet50(0, [{ address: 2000, control: 0x45, label: "PGM" }])]));
      await expect.poll(() => receiver.snapshot().displays.length).toBe(3);
      expect(receiver.resolve(0, 2000)).toMatchObject({ label: "PGM", right: 1, text: 1, left: 0 });
      expect(receiver.snapshot().invalidPackets).toBe(0);
    } finally {
      socket.destroy();
      await receiver.stop();
    }
  });
});
