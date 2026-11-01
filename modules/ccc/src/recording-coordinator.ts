import type { ModuleJsonValue as JsonValue } from "@hubble/module-sdk";
import type { RecordingBatchResult as ModuleActionResult } from "./recording-result.js";
import type {
  CyanViewCameraObservation,
  CyanViewCameraTarget,
} from "./rcp-session.js";

export interface RecordingSession {
  observeTarget(target: CyanViewCameraTarget): CyanViewCameraObservation;
  sendCameraCommand(
    target: CyanViewCameraTarget,
    command: "Rec" | "Stop" | "RecToggle",
    signal?: AbortSignal,
    submitted?: () => void,
  ): Promise<void>;
}
export interface RecordingTarget {
  readonly key: string;
  readonly session: RecordingSession;
  readonly target: CyanViewCameraTarget;
}
export type RecordingIntent = "start" | "stop" | "toggle";
export type RecordingResult = ModuleActionResult["targets"][number];

/** The single module-owned authority shared by every recording entry point. */
export class RecordingCoordinator {
  private recovery: "initial" | "clean" | "unclean" = "initial";
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly depths = new Map<string, number>();
  private readonly uncertain = new Map<
    string,
    { generation: number; sequence: number }
  >();
  private readonly changes = new Set<() => void>();
  private readonly stopped = new AbortController();
  private readonly slots: {
    resolve(release: () => void): void;
    reject(error: Error): void;
    signal: AbortSignal;
    abort: () => void;
  }[] = [];
  private publishers = 0;
  private pending = 0;

  constructor(
    private readonly options: {
      readonly feedbackTimeoutMs: number;
      readonly publishConcurrency?: number;
      readonly recovery?: "initial" | "clean" | "unclean";
      readonly checkpoint?: JsonValue;
      readonly changed?: () => void;
    },
  ) {
    this.restore(options.checkpoint, options.recovery ?? "initial");
  }

  restore(
    checkpoint: JsonValue | undefined,
    recovery: "initial" | "clean" | "unclean",
  ): void {
    this.recovery = recovery;
    this.uncertain.clear();
    if (
      checkpoint &&
      typeof checkpoint === "object" &&
      !Array.isArray(checkpoint) &&
      "uncertain" in checkpoint &&
      Array.isArray(checkpoint.uncertain)
    ) {
      for (const key of checkpoint.uncertain)
        if (typeof key === "string")
          this.uncertain.set(key, { generation: -1, sequence: 0 });
    }
  }

  notify(): void {
    for (const changed of [...this.changes]) changed();
  }
  isUncertain(key: string): boolean {
    return this.uncertain.has(key);
  }
  checkpoint(): JsonValue {
    return { uncertain: [...this.uncertain.keys()] };
  }

  usableObservation(
    key: string,
    target: CyanViewCameraTarget,
    observation: CyanViewCameraObservation,
  ): boolean {
    const barrier = this.uncertain.get(key);
    const fresh =
      observation.recordingSequence > 0 &&
      (!barrier ||
        target.generation !== barrier.generation ||
        observation.recordingSequence > barrier.sequence);
    if ((barrier || this.recovery === "unclean") && !fresh) return false;
    if (barrier) this.uncertain.delete(key);
    return true;
  }

  async deliver(
    operation: () => Promise<void>,
    callerSignal?: AbortSignal,
  ): Promise<void> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.stopped.signal])
      : this.stopped.signal;
    const release = await this.acquire(signal);
    try {
      if (signal.aborted) throw new Error("Camera command was cancelled");
      await operation();
    } finally {
      release();
    }
  }

  record(
    captured: RecordingTarget,
    intent: RecordingIntent,
    callerSignal?: AbortSignal,
  ): Promise<RecordingResult> {
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, this.stopped.signal])
      : this.stopped.signal;
    if (this.pending >= 4096 || (this.depths.get(captured.key) ?? 0) >= 32)
      return Promise.resolve(
        this.result(captured.key, "error", "Camera recording queue is full"),
      );
    this.pending += 1;
    this.depths.set(captured.key, (this.depths.get(captured.key) ?? 0) + 1);
    const prior = this.tails.get(captured.key) ?? Promise.resolve();
    const run = () => this.run(captured, intent, signal);
    const operation = prior.then(run, run);
    const tail = operation.finally(() => {
      this.pending -= 1;
      const depth = (this.depths.get(captured.key) ?? 1) - 1;
      if (depth) this.depths.set(captured.key, depth);
      else this.depths.delete(captured.key);
      if (this.tails.get(captured.key) === tail)
        this.tails.delete(captured.key);
    });
    this.tails.set(captured.key, tail);
    return tail;
  }

  async dispose(): Promise<void> {
    this.stopped.abort();
    this.notify();
    await Promise.allSettled([...this.tails.values()]);
    this.changes.clear();
  }

  private async run(
    captured: RecordingTarget,
    intent: RecordingIntent,
    signal: AbortSignal,
  ): Promise<RecordingResult> {
    const { key, session, target } = captured;
    const transmission = { sent: false };
    let before = 0;
    let expected = false;
    let release: (() => void) | undefined;
    try {
      release = await this.acquire(signal);
      if (signal.aborted)
        throw new Error("Recording command was cancelled before sending");
      // No cached decision survives the same-camera queue or publisher queue.
      const current = session.observeTarget(target);
      if (current.online !== true || current.recording === null)
        throw new Error("Camera recording state is unknown or offline");
      if (current.recordingLocked)
        return this.result(key, "skipped", "Camera recording is locked");
      if (current.recordMode === null)
        throw new Error("Camera recording capabilities are unavailable");
      if (!this.usableObservation(key, target, current))
        throw new Error(
          "Waiting for fresh camera state after an uncertain operation or restart",
        );
      expected = intent === "toggle" ? !current.recording : intent === "start";
      if (current.recording === expected)
        return this.result(
          key,
          "noop",
          expected
            ? "Camera is already recording"
            : "Camera is already stopped",
        );
      before = current.recordingSequence;
      const command =
        current.recordMode === "toggle"
          ? "RecToggle"
          : expected
            ? "Rec"
            : "Stop";
      await session.sendCameraCommand(target, command, signal, () => {
        transmission.sent = true;
      });
      release();
      release = undefined;
      const confirmed = await this.wait(captured, before, expected, signal);
      if (confirmed)
        return this.result(
          key,
          "confirmed",
          "Confirmed by fresh camera feedback",
        );
      this.markUncertain(captured, before);
      return this.result(
        key,
        "unconfirmed",
        isAborted(signal)
          ? "Command may have been sent; cancelled while awaiting camera feedback"
          : "Command delivered; matching fresh camera feedback was not received",
      );
    } catch (error) {
      if (transmission.sent) this.markUncertain(captured, before);
      return this.result(
        key,
        transmission.sent ? "unconfirmed" : "error",
        error instanceof Error ? error.message : "Recording command failed",
      );
    } finally {
      release?.();
    }
  }

  private markUncertain(captured: RecordingTarget, sequence: number): void {
    try {
      sequence = Math.max(
        sequence,
        captured.session.observeTarget(captured.target).recordingSequence,
      );
    } catch {
      /* A reconnect requires fresh status in its new generation. */
    }
    this.uncertain.set(captured.key, {
      generation: captured.target.generation,
      sequence,
    });
    this.options.changed?.();
  }

  private result(
    target: string,
    evidence: RecordingResult["evidence"],
    message: string,
  ): RecordingResult {
    return {
      target,
      outcome:
        evidence === "noop" || evidence === "confirmed" ? "success" : "failure",
      evidence,
      message: message.slice(0, 1024),
    };
  }

  private wait(
    captured: RecordingTarget,
    before: number,
    expected: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (confirmed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.changes.delete(check);
        signal.removeEventListener("abort", abort);
        resolve(confirmed);
      };
      const check = () => {
        try {
          const current = captured.session.observeTarget(captured.target);
          if (current.online !== true || current.recording === null) {
            finish(false);
            return;
          }
          if (
            current.recordingSequence > before &&
            current.recording === expected
          )
            finish(true);
        } catch {
          finish(false);
        }
      };
      const abort = () => {
        finish(false);
      };
      const timer = setTimeout(abort, this.options.feedbackTimeoutMs);
      this.changes.add(check);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) finish(false);
      else check();
    });
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted)
      return Promise.reject(
        new Error("Recording command was cancelled before sending"),
      );
    if (this.publishers < (this.options.publishConcurrency ?? 4)) {
      this.publishers += 1;
      return Promise.resolve(() => {
        this.release();
      });
    }
    return new Promise((resolve, reject) => {
      const item = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.slots.indexOf(item);
          if (index !== -1) this.slots.splice(index, 1);
          signal.removeEventListener("abort", item.abort);
          reject(new Error("Recording command was cancelled before sending"));
        },
      };
      this.slots.push(item);
      signal.addEventListener("abort", item.abort, { once: true });
    });
  }

  private release(): void {
    const item = this.slots.shift();
    if (item) {
      item.signal.removeEventListener("abort", item.abort);
      item.resolve(() => {
        this.release();
      });
    } else this.publishers -= 1;
  }
}

// Cancellation can change while awaiting delivery or camera feedback.
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}
