import net from "node:net";
import { decodeKeyPacket } from "../src/protocol.js";

export type MonitorEvent =
  | { readonly type: "open"; readonly client: number }
  | { readonly type: "key"; readonly client: number; readonly code: number }
  | { readonly type: "bad-packet"; readonly client: number; readonly hex: string }
  | { readonly type: "client-closed"; readonly client: number }
  | { readonly type: "dropped"; readonly client: number };

/**
 * A stand-in FSI monitor control port on loopback. How a real monitor treats a
 * second client isn't documented, so `newest-wins` models FSI's warning: a new
 * connection drops whoever was connected. `many` accepts everyone.
 */
export class FakeMonitor {
  readonly events: MonitorEvent[] = [];
  readonly #server = net.createServer((socket) => this.#accept(socket));
  readonly #open = new Map<number, net.Socket>();
  #next = 1;

  constructor(readonly policy: "newest-wins" | "many" = "newest-wins") {}

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, "127.0.0.1", () => resolve());
    });
    return (this.#server.address() as net.AddressInfo).port;
  }

  get keys(): number[] {
    return this.events.flatMap((event) => (event.type === "key" ? [event.code] : []));
  }

  get openClients(): number[] {
    return [...this.#open.keys()];
  }

  #accept(socket: net.Socket) {
    socket.setNoDelay(true);
    const client = this.#next++;
    if (this.policy === "newest-wins")
      for (const [id, other] of this.#open) {
        this.events.push({ type: "dropped", client: id });
        other.destroy();
        this.#open.delete(id);
      }
    this.#open.set(client, socket);
    this.events.push({ type: "open", client });
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 12) {
        const packet = buffered.subarray(0, 12);
        buffered = buffered.subarray(12);
        const code = decodeKeyPacket(packet);
        this.events.push(
          code === null
            ? { type: "bad-packet", client, hex: packet.toString("hex") }
            : { type: "key", client, code },
        );
      }
    });
    socket.on("end", () => {
      this.events.push({ type: "client-closed", client });
      socket.end();
    });
    socket.on("close", () => this.#open.delete(client));
    socket.on("error", () => {});
  }

  async close(): Promise<void> {
    for (const socket of this.#open.values()) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
