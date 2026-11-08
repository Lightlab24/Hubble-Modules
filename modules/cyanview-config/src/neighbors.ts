import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validIp } from './model.js';

const run = promisify(execFile);
export function parseNeighbors(text: string): string[] {
  const addresses = new Set<string>();
  for (const line of text.split('\n')) {
    if (/incomplete|failed|unreachable/i.test(line)) continue;
    if (/ff[:-]ff[:-]ff[:-]ff[:-]ff[:-]ff/i.test(line)) continue;
    if (!/(?:[a-f\d]{1,2}[:-]){5}[a-f\d]{1,2}/i.test(line)) continue;
    const address = line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0];
    if (address && validIp(address)) addresses.add(address);
  }
  return [...addresses].slice(0, 1024);
}

/** Read the existing OS neighbor cache; never ping or sweep addresses to populate it. */
export async function readNeighbors(signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? '/usr/sbin/arp' : process.platform === 'win32' ? 'arp.exe' : 'ip';
  const args = process.platform === 'linux' ? ['-4', 'neigh', 'show'] : process.platform === 'win32' ? ['-a'] : ['-an'];
  try { const { stdout } = await run(command, args, { signal, timeout: 2000, maxBuffer: 8 * 1024 * 1024 }); return parseNeighbors(stdout); }
  catch { signal.throwIfAborted(); return []; }
}
