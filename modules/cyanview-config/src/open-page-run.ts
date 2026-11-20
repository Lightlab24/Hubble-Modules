import { spawn } from 'node:child_process';
import { object, validIp } from './model.js';

export type PageLauncher = { file: string; args: (url: string) => string[] };
/**
 * Safari first, as asked for. A computer without it gets its own browser. Nothing here goes through a shell:
 * the only thing ever handed over is `http://` and an IPv4 address that was checked.
 */
export const pageLaunchers = (platform: NodeJS.Platform = process.platform): PageLauncher[] => platform === 'darwin'
  ? [{ file: '/usr/bin/open', args: url => ['-a', 'Safari', url] }, { file: '/usr/bin/open', args: url => [url] }]
  : [{ file: 'xdg-open', args: url => [url] }];

/** A controller's own web page is plain http at its address. */
export function devicePageUrl(value: unknown) {
  const address = String(object(value).address ?? '').trim();
  if (!validIp(address)) throw new Error('Enter a valid IPv4 address');
  return 'http://' + address + '/';
}

function launch(launcher: PageLauncher, url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(launcher.file, launcher.args(url), { stdio: 'ignore' });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => { child.kill('SIGTERM'); finish(new Error('Opening the page was cancelled')); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('The browser did not open in time')); }, 4000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', () => finish(new Error('The browser could not be started')));
    child.once('close', code => finish(code === 0 ? undefined : new Error('The browser could not be opened')));
  });
}

/** Opens a controller's own web page in the browser on this computer. Owned by the declared host helper. */
export async function runOpenPage(value: unknown, signal: AbortSignal, launchers = pageLaunchers()) {
  const url = devicePageUrl(value);
  signal.throwIfAborted();
  let failure: unknown;
  for (const launcher of launchers) {
    try { await launch(launcher, url, signal); return { opened: url }; }
    catch (error) { failure = error; signal.throwIfAborted(); }
  }
  throw failure instanceof Error ? failure : new Error('The browser could not be opened');
}
