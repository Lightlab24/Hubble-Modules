import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validIp } from './model.js';

const run = promisify(execFile);
export function parseNeighbors(text: string, accept: (address: string) => boolean = () => true): string[] {
  const addresses = new Set<string>();
  for (const line of text.split('\n')) {
    if (/incomplete|failed|unreachable/i.test(line)) continue;
    if (/ff[:-]ff[:-]ff[:-]ff[:-]ff[:-]ff/i.test(line)) continue;
    if (!/(?:[a-f\d]{1,2}[:-]){5}[a-f\d]{1,2}/i.test(line)) continue;
    const address = line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0];
    if (address && validIp(address) && accept(address)) addresses.add(address);
    if (addresses.size >= 4096) break;
  }
  return [...addresses];
}

/**
 * Read the existing OS neighbor cache; never ping or sweep addresses to populate it. Right after a sweep the
 * cache can list every address in a /16, nearly all unanswered, so the read allows for that much output.
 */
export async function readNeighbors(signal: AbortSignal, accept?: (address: string) => boolean): Promise<string[]> {
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? '/usr/sbin/arp' : process.platform === 'win32' ? 'arp.exe' : 'ip';
  const args = process.platform === 'linux' ? ['-4', 'neigh', 'show'] : process.platform === 'win32' ? ['-a'] : ['-an'];
  try { const { stdout } = await run(command, args, { signal, timeout: 5000, maxBuffer: 16 * 1024 * 1024 }); return parseNeighbors(stdout, accept); }
  catch { signal.throwIfAborted(); return []; }
}
