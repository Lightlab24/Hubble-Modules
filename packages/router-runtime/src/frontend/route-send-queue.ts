import {
  routeCellKey,
  type RouteCellOverlay,
  type RoutePick,
  type RouteSendOutcome,
} from "./routes-sheet-model.js";

export interface RouteSendClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RouteSendQueueOptions {
  send(pick: RoutePick): Promise<RouteSendOutcome>;
  /** The router's current source for a target, as last observed. */
  read(destination: number, level: number): number | null;
  /** How long an acknowledged route may wait to be observed. */
  confirmTimeoutMs(): number;
  onChange(): void;
  onFailure(message: string): void;
  clock?: RouteSendClock;
}

interface DesiredRoute {
  readonly pick: RoutePick;
  readonly source: number;
  phase: "queued" | "sending";
}

interface ConfirmingRoute {
  readonly destination: number;
  readonly level: number;
  readonly source: number;
  readonly deadline: number;
}

const DEFAULT_CLOCK: RouteSendClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Sends sheet picks one at a time so each cell can change at once while earlier
 * routes are still going out. The newest pick for a target replaces one that
 * hasn't been sent, and a target waits until its last route has been observed.
 */
export class RouteSendQueue {
  readonly #options: RouteSendQueueOptions;
  readonly #clock: RouteSendClock;
  readonly #desired = new Map<string, DesiredRoute>();
  readonly #confirming = new Map<string, ConfirmingRoute>();
  #waiting: RoutePick[] = [];
  #active: RoutePick | null = null;
  #timer: unknown = undefined;
  #timerScheduled = false;

  constructor(options: RouteSendQueueOptions) {
    this.#options = options;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
  }

  overlay(destination: number, level: number): RouteCellOverlay | undefined {
    const key = routeCellKey(destination, level);
    const desired = this.#desired.get(key);
    if (desired !== undefined)
      return { source: desired.source, phase: desired.phase };
    const confirming = this.#confirming.get(key);
    return confirming === undefined
      ? undefined
      : { source: confirming.source, phase: "confirming" };
  }

  enqueue(pick: RoutePick): void {
    this.#waiting = this.#waiting
      .map((waiting) =>
        waiting.destination === pick.destination
          ? {
              ...waiting,
              levels: waiting.levels.filter(
                (level) => !pick.levels.includes(level),
              ),
            }
          : waiting,
      )
      .filter(({ levels }) => levels.length > 0);
    this.#waiting.push(pick);
    for (const level of pick.levels)
      this.#desired.set(routeCellKey(pick.destination, level), {
        pick,
        source: pick.source,
        phase: "queued",
      });
    this.#options.onChange();
    this.#pump();
  }

  /** Call whenever router truth changes. */
  observe(): void {
    let changed = false;
    for (const [key, route] of this.#confirming) {
      if (this.#options.read(route.destination, route.level) === route.source) {
        this.#confirming.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    this.#schedule();
    this.#options.onChange();
    this.#pump();
  }

  /** Drop everything unsent. A queued route must never fire after a reconnect. */
  cancel(message: string | null): void {
    const unsent = this.#waiting.length > 0 || this.#active !== null;
    this.#waiting = [];
    this.#active = null;
    const hadRoutes = this.#desired.size > 0 || this.#confirming.size > 0;
    this.#desired.clear();
    this.#confirming.clear();
    this.#schedule();
    if (hadRoutes) this.#options.onChange();
    if (unsent && message !== null) this.#options.onFailure(message);
  }

  dispose(): void {
    this.cancel(null);
  }

  #pump(): void {
    if (this.#active !== null) return;
    const index = this.#waiting.findIndex((pick) =>
      pick.levels.every(
        (level) => !this.#confirming.has(routeCellKey(pick.destination, level)),
      ),
    );
    if (index < 0) return;
    const [pick] = this.#waiting.splice(index, 1);
    if (pick === undefined) return;
    this.#active = pick;
    for (const level of pick.levels) {
      const desired = this.#desired.get(routeCellKey(pick.destination, level));
      if (desired?.pick === pick) desired.phase = "sending";
    }
    this.#options.onChange();
    let sent: Promise<RouteSendOutcome>;
    try {
      sent = this.#options.send(pick);
    } catch (error) {
      sent = Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    void sent.then(
      (outcome) => {
        this.#finish(pick, outcome);
      },
      () => {
        this.#finish(pick, {
          succeededLevels: [],
          failedLevels: pick.levels,
          message: `Destination ${String(pick.destination)} wasn't routed: the router command is unavailable.`,
        });
      },
    );
  }

  #finish(pick: RoutePick, outcome: RouteSendOutcome): void {
    if (this.#active !== pick) return;
    this.#active = null;
    const deadline = this.#clock.now() + this.#options.confirmTimeoutMs();
    const clearIfCurrent = (level: number): void => {
      const key = routeCellKey(pick.destination, level);
      if (this.#desired.get(key)?.pick === pick) this.#desired.delete(key);
    };
    for (const level of outcome.failedLevels) clearIfCurrent(level);
    for (const level of outcome.succeededLevels) {
      clearIfCurrent(level);
      if (this.#options.read(pick.destination, level) !== pick.source)
        this.#confirming.set(routeCellKey(pick.destination, level), {
          destination: pick.destination,
          level,
          source: pick.source,
          deadline,
        });
    }
    this.#schedule();
    this.#options.onChange();
    if (outcome.message !== null) this.#options.onFailure(outcome.message);
    this.#pump();
  }

  #schedule(): void {
    if (this.#timerScheduled) {
      this.#clock.clearTimeout(this.#timer);
      this.#timerScheduled = false;
    }
    if (this.#confirming.size === 0) return;
    const next = Math.min(
      ...[...this.#confirming.values()].map(({ deadline }) => deadline),
    );
    this.#timer = this.#clock.setTimeout(
      () => {
        this.#timerScheduled = false;
        this.#expire();
      },
      Math.max(0, next - this.#clock.now()),
    );
    this.#timerScheduled = true;
  }

  #expire(): void {
    const now = this.#clock.now();
    const destinations = new Set<number>();
    for (const [key, route] of this.#confirming) {
      if (route.deadline > now) continue;
      this.#confirming.delete(key);
      destinations.add(route.destination);
    }
    this.#schedule();
    if (destinations.size === 0) return;
    this.#options.onChange();
    this.#options.onFailure(
      `The router accepted the route for destination ${[...destinations].join(", ")} but hasn't confirmed it.`,
    );
    this.#pump();
  }
}
