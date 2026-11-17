import { execFile } from "node:child_process";
import path from "node:path";

/**
 * Apps such as LiveGrade and FSI's IP Remote Utility hold a connection to the
 * monitor's control port. FSI warns that connecting a second time "may
 * interrupt connectivity to those applications". Before each key Hubble reads
 * this Mac's own TCP table, which the system shows without special access,
 * and looks for anyone else connected to the same monitor and port.
 *
 * It can only see this Mac. An app on another computer is invisible here.
 */
export interface OtherConnection {
  /** The app's name, as best this Mac reports it. */
  readonly app: string;
  readonly pid: number | null;
  readonly state: string;
}

/** Connection states that mean another app is using, or opening, the port. */
const OPEN_STATES = new Set(["ESTABLISHED", "SYN_SENT"]);

// tcp4  0  0  10.0.0.2.51234  10.0.0.9.18181  ESTABLISHED  rx tx rhiwat shiwat  Livegrade Studio:1234  00102 ...
// The process column is up to 16 characters and may contain spaces.
const LINE =
  /^tcp\S*\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+\d+\s+\d+\s+\d+\s+\d+\s+(.+?):(\d+)\s+[0-9a-f]{5}\s)?/u;

function sameHost(endpoint: string, address: string, port: number) {
  const suffix = `.${port}`;
  if (!endpoint.endsWith(suffix)) return false;
  const host = endpoint
    .slice(0, -suffix.length)
    .toLowerCase()
    .replace(/^::ffff:/u, "")
    .replace(/%.*$/u, "");
  return host === address.toLowerCase().replace(/%.*$/u, "");
}

/** Finds other open connections to `address`:`port` in `netstat -anv -p tcp` output. */
export function parseNetstat(
  text: string,
  address: string,
  port: number,
  excludePid: number | null = process.pid,
): OtherConnection[] {
  const found: OtherConnection[] = [];
  for (const line of text.split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const [, , foreign, state, processName, pid] = match;
    if (!OPEN_STATES.has(state!) || !sameHost(foreign!, address, port)) continue;
    const owner = pid === undefined ? null : Number(pid);
    if (owner !== null && owner === excludePid) continue;
    found.push({ app: processName?.trim() || "Another app", pid: owner, state: state! });
  }
  return found;
}

function run(file: string, args: string[], signal: AbortSignal, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { signal, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** The app's own name from its executable path: its .app bundle, else the file name. */
export function appName(executable: string): string | null {
  const bundle = /([^/]+)\.app\//u.exec(executable);
  if (bundle) return bundle[1]!;
  const base = path.basename(executable.trim());
  return base || null;
}

export interface ConnectionLister {
  (address: string, port: number, signal: AbortSignal): Promise<OtherConnection[]>;
}

/** Reads this Mac's TCP table, then names each app from its process. */
export const listOtherConnections: ConnectionLister = async (address, port, signal) => {
  const table = await run("/usr/sbin/netstat", ["-anv", "-p", "tcp"], signal, 2000);
  const found = parseNetstat(table, address, port);
  return Promise.all(
    found.map(async (item) => {
      if (item.pid === null) return item;
      try {
        const executable = await run("/bin/ps", ["-o", "comm=", "-p", String(item.pid)], signal, 1000);
        return { ...item, app: appName(executable) ?? item.app };
      } catch {
        return item;
      }
    }),
  );
};

/** "LiveGrade", "LiveGrade and IP Remote Utility", "LiveGrade, nc and IP Remote Utility". */
export function describeApps(found: readonly OtherConnection[]): string {
  const names = [...new Set(found.map((item) => item.app))];
  if (names.length <= 1) return names[0] ?? "Another app";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
