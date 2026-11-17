// A stand-in FSI monitor on loopback that prints each key it receives.
//   node_modules/.bin/tsx modules/flanders-monitor/tools/fake-monitor.ts [port] [newest-wins|many]
// Point a Flanders connection at 127.0.0.1 and this port. It never listens beyond this Mac.
import { KEYS } from "../src/keys.js";
import { FakeMonitor } from "../test/fake-monitor.js";

const port = Number(process.argv[2] ?? 18181);
const policy = process.argv[3] === "many" ? "many" : "newest-wins";
const monitor = new FakeMonitor(policy);
const names = new Map(KEYS.map((key) => [key.code, key.label]));
const listening = await monitor.listen(port);
console.log(`Fake FSI monitor on 127.0.0.1:${listening} (${policy})`);
let shown = 0;
setInterval(() => {
  for (const event of monitor.events.slice(shown)) {
    const time = new Date().toISOString().slice(11, 23);
    if (event.type === "key") console.log(`${time} client ${event.client} pressed ${names.get(event.code) ?? `0x${event.code.toString(16)}`}`);
    else console.log(`${time} client ${event.client} ${event.type}${"hex" in event ? ` ${event.hex}` : ""}`);
  }
  shown = monitor.events.length;
}, 50);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => void monitor.close().then(() => process.exit(0)));
