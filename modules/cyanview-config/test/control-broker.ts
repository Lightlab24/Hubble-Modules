import { createServer } from "node:net";
import { once } from "node:events";
import { createBroker } from "../src/simulated/broker.js";

/**
 * A simulated controller's MQTT broker on a loopback TCP port, as the tests reach it through a real socket. The
 * broker itself is the one Simulated runs in the worker over in-memory connections.
 */
const cleanups: (() => Promise<void>)[] = [];
export async function closeBrokers(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
export async function broker(port = 0, options: { onlyHubble?: boolean } = {}) {
  const simulated = createBroker(options);
  const server = createServer((socket) => simulated.accept(socket));
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing broker address");
  cleanups.push(async () => {
    simulated.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
  return Object.assign(simulated, { port: address.port });
}
