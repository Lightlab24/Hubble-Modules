import net from "node:net";
import { lookup } from "node:dns/promises";

export class SendError extends Error {
  constructor(
    readonly category: "unavailable" | "timeout" | "cancelled",
    message: string,
    /** True once any byte may have left this Mac. */
    readonly maybeSent: boolean,
  ) {
    super(message);
  }
}

/** An IP address as given, or the first address the name resolves to. */
export async function resolveAddress(host: string, signal: AbortSignal): Promise<string> {
  if (net.isIP(host)) return host;
  if (signal.aborted) throw new SendError("cancelled", "Cancelled before sending", false);
  try {
    return (await lookup(host)).address;
  } catch {
    throw new SendError("unavailable", `Couldn't find ${host} on the network`, false);
  }
}

export interface SendOptions {
  readonly address: string;
  readonly port: number;
  readonly packet: Uint8Array;
  readonly signal: AbortSignal;
  /** How long to wait for the monitor to accept the connection. */
  readonly connectTimeoutMs?: number;
  /** After sending, how long to wait for the monitor to close its side before Hubble drops the socket. */
  readonly closeWaitMs?: number;
}

/**
 * Opens a connection, writes one packet, closes it and waits until the socket
 * is gone. Nothing stays connected between keys, so Hubble never holds the
 * monitor's control port for longer than one key takes.
 */
export function sendOnce({
  address,
  port,
  packet,
  signal,
  connectTimeoutMs = 2000,
  closeWaitMs = 300,
}: SendOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SendError("cancelled", "Cancelled before sending", false));
      return;
    }
    let written = false;
    let settled = false;
    let closeTimer: NodeJS.Timeout | undefined;
    const socket = net.createConnection({ host: address, port, noDelay: true });
    const connectTimer = setTimeout(
      () => fail(new SendError("timeout", `The monitor at ${address} didn't answer within ${connectTimeoutMs / 1000} s. Nothing was sent.`, false)),
      connectTimeoutMs,
    );
    const onAbort = () =>
      fail(new SendError("cancelled", written ? "Cancelled after sending" : "Cancelled before sending", written));
    signal.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(connectTimer);
      clearTimeout(closeTimer);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(error: SendError) {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    }
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      socket.write(packet, (error) => {
        if (error) {
          fail(new SendError("unavailable", `The connection to ${address} failed while sending`, true));
          return;
        }
        written = true;
        // Half-close, then give the monitor a moment to close its side so the
        // port is free before the next key. Drop the socket either way.
        socket.end();
        closeTimer = setTimeout(() => socket.destroy(), closeWaitMs);
      });
    });
    // A late reply is ignored. Reading it keeps the socket able to close cleanly.
    socket.on("data", () => {});
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (written) return; // The packet is out; a reset while closing changes nothing.
      const reason =
        error.code === "ECONNREFUSED"
          ? `The monitor at ${address} refused the connection on port ${port}`
          : error.code === "EHOSTUNREACH" || error.code === "ENETUNREACH"
            ? `No route to ${address}`
            : `Couldn't connect to ${address}:${port} (${error.code ?? error.message})`;
      fail(new SendError("unavailable", `${reason}. Nothing was sent.`, false));
    });
    socket.once("close", () => {
      if (settled) return;
      if (!written) {
        fail(new SendError("unavailable", `The monitor at ${address} closed the connection before the key was sent`, false));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    });
  });
}
