import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Runs the system's fping in loop mode: one process pings every address at the
 * chosen time and size and prints one line per answer or timeout. Changing the
 * addresses, time or size starts a new process. Nothing else is sent to a device.
 */
export interface PingSample {
  readonly address: string;
  /** ms since 1970, from fping's own clock. */
  readonly at: number;
  /** Answer time in ms, or null when the ping timed out. */
  readonly rtt: number | null;
}
export interface PingPlan {
  readonly addresses: readonly string[];
  readonly intervalMs: number;
  readonly sizeBytes: number;
}
export interface PingProcess {
  readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}
export interface PingerOptions {
  /** Starts the ping process. Tests pass a stand-in. */
  readonly start?: (args: readonly string[]) => PingProcess;
  readonly restartMs?: number;
}

const FPING_PATHS = ["/usr/bin/fping", "/usr/sbin/fping", "/opt/homebrew/sbin/fping", "/opt/homebrew/bin/fping", "/usr/local/sbin/fping", "/usr/local/bin/fping"];
export function findFping(): string | undefined {
  return FPING_PATHS.find((file) => existsSync(file));
}

/** fping's arguments for a plan: loop, timestamps, the period, a 1 ms gap between devices, and the data size. */
export function pingArguments(plan: PingPlan): string[] {
  return ["-l", "-D", "-p", String(plan.intervalMs), "-i", "1", "-b", String(plan.sizeBytes), ...plan.addresses];
}

// [1795132193.81926] 127.0.0.1 : [0], 64 bytes, 0.211 ms (0.211 avg, 0% loss)
// [1795132194.12204] 192.0.2.1 : [0], timed out (NaN avg, 100% loss)
const LINE = /^\[(\d+(?:\.\d+)?)\]\s+(\S+)\s+:\s+\[\d+\],\s+(?:\d+ bytes,\s+([\d.]+) ms|timed out)/u;
export function parsePingLine(line: string): PingSample | null {
  const match = LINE.exec(line);
  if (!match) return null;
  const rtt = match[3] === undefined ? null : Number(match[3]);
  if (rtt !== null && !Number.isFinite(rtt)) return null;
  return { address: match[2]!, at: Math.round(Number(match[1]) * 1000), rtt };
}

export class Pinger {
  private process: PingProcess | undefined;
  private plan: PingPlan | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Why nothing is being pinged, for the page to show; empty while fping runs. */
  problem = "";

  constructor(
    private readonly onSample: (sample: PingSample) => void,
    private readonly onProblem: (message: string) => void,
    private readonly options: PingerOptions = {},
  ) {}

  /** Pings exactly this plan from now on. An empty address list stops pinging. */
  configure(plan: PingPlan) {
    const next = { ...plan, addresses: [...new Set(plan.addresses)].sort() };
    if (this.plan && this.process && JSON.stringify(next) === JSON.stringify(this.plan)) return;
    this.plan = next;
    this.restart();
  }

  private setProblem(message: string) {
    if (this.problem === message) return;
    this.problem = message;
    this.onProblem(message);
  }

  private restart() {
    clearTimeout(this.timer);
    const old = this.process;
    this.process = undefined;
    old?.kill();
    const plan = this.plan;
    if (this.stopped || !plan || !plan.addresses.length) {
      this.setProblem("");
      return;
    }
    let child: PingProcess;
    try {
      if (this.options.start) child = this.options.start(pingArguments(plan));
      else {
        const file = findFping();
        if (!file) {
          this.setProblem("Ping needs fping on this computer, and it isn't installed.");
          return;
        }
        child = spawn(file, pingArguments(plan), { stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildProcessWithoutNullStreams;
        // fping reports unreachable networks and its closing summary on stderr; drain it so the pipe never fills.
        (child as unknown as ChildProcessWithoutNullStreams).stderr.resume();
      }
    } catch (error) {
      this.setProblem(`Couldn't start pinging: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.process = child;
    let rest = "";
    child.stdout.on("data", (chunk) => {
      if (this.process !== child) return;
      rest += String(chunk);
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const sample = parsePingLine(line);
        if (sample) {
          this.setProblem("");
          this.onSample(sample);
        }
      }
    });
    const ended = (why: string) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.setProblem(why);
      this.timer = setTimeout(() => this.restart(), this.options.restartMs ?? 2000);
    };
    child.on("error", (error) => ended(`Couldn't start pinging: ${error.message}`));
    child.on("exit", () => ended("Pinging stopped unexpectedly. Starting again."));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    const old = this.process;
    this.process = undefined;
    old?.kill();
  }
}
