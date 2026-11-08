import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { object, validIp } from './model.js';

export const pingPolicy = { payloadBytes: 4, workers: 4, batchSize: 1024, intervalMs: 1, timeoutMs: 300, retries: 0 } as const;
export const ipNumber = (address: string) => address.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
export function validatePingBatch(value: unknown) {
  const input = object(value), first = String(input.first ?? ''), last = String(input.last ?? '');
  if (!validIp(first) || !validIp(last)) throw new Error('Invalid ping range');
  const start = ipNumber(first), end = ipNumber(last);
  if (end < start || end - start >= pingPolicy.batchSize || Math.floor(start / 65536) !== Math.floor(end / 65536)) throw new Error('Ping batches must contain at most 1024 addresses within one /16');
  return { first, last, start, end, count: end - start + 1 };
}
async function executable() {
  for (const file of ['/usr/bin/fping', '/usr/sbin/fping', '/opt/homebrew/sbin/fping', '/opt/homebrew/bin/fping', '/usr/local/sbin/fping', '/usr/local/bin/fping']) {
    try { await access(file, constants.X_OK); return file; } catch { /* Try another standard installation location. */ }
  }
  throw new Error('Fast IP discovery requires fping on this computer. Use Full IP scan or Find by IP.');
}

/** One bounded, cancellable system-utility call, owned by the declared host helper. */
export async function runPingBatch(value: unknown, signal: AbortSignal, command?: string) {
  const range = validatePingBatch(value); signal.throwIfAborted();
  const file = command ?? await executable(); signal.throwIfAborted();
  return new Promise<{ alive: string[]; checked: number }>((resolve, reject) => {
    const child = spawn(file, ['-4', '-a', '-q', '-b', String(pingPolicy.payloadBytes), '-i', String(pingPolicy.intervalMs), '-r', '0', '-t', String(pingPolicy.timeoutMs), '-g', range.first, range.last], { stdio: ['ignore', 'pipe', 'pipe'] });
    const alive = new Set<string>(); let buffer = '', diagnostic = '', bytes = 0, failure: Error | undefined, finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 200); };
    const abort = () => { failure = new Error('IP discovery cancelled'); stop(); };
    const timer = setTimeout(() => { failure = new Error('Ping batch timed out'); stop(); }, 6000);
    const line = (text: string) => { const ip = text.trim(); if (validIp(ip) && ipNumber(ip) >= range.start && ipNumber(ip) <= range.end) alive.add(ip); };
    const finish = (error?: Error) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else { if (buffer) line(buffer); resolve({ alive: [...alive], checked: range.count }); }
    };
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (text: string) => {
      bytes += text.length; if (bytes > 65536) { failure = new Error('Unexpected ping output'); stop(); return; }
      buffer += text; let at: number; while ((at = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (text: string) => { diagnostic = (diagnostic + text).slice(0, 500); });
    child.once('error', () => finish(new Error('Could not start fping. Use Full IP scan or Find by IP.')));
    child.once('close', code => finish(failure ?? (code === 0 || code === 1 ? undefined : new Error('Ping scanner failed' + (diagnostic ? ': ' + diagnostic.trim() : '')))));
  });
}
