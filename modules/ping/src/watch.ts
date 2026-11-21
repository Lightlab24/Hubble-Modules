import { History, round, type Series } from "./history.js";
import type { Rules } from "./model.js";

/**
 * What Ping knows about one device: its history, and whether it is answering.
 * A device goes Offline once it hasn't answered for its lost time and Slow as
 * soon as an answer is over its limit; it is Online again on the next answer,
 * or after three answers in a row under the limit.
 *
 * The first state a device settles into is where it starts, not a change, so it
 * raises no alert: a restart, a newly added device or a new address never
 * announces something that was already so. Every change after that does.
 */
export type DeviceState = "not-checked" | "online" | "slow" | "offline";
export interface Alert {
  readonly level: "error" | "info";
  readonly stage: string;
  /** The whole event in one line, for the Status Log. */
  readonly message: string;
  /** The same event as a notification: what happened to which device, then the detail. */
  readonly title: string;
  readonly body: string;
}
export interface DeviceSummary {
  readonly state: DeviceState;
  /** When it entered this state, ms since 1970. */
  readonly since: number | null;
  readonly now: number | null;
  readonly average: number | null;
  readonly best: number | null;
  readonly worst: number | null;
  readonly jitter: number | null;
  /** Percent of pings lost, or null before any ping. */
  readonly lostPct: number | null;
  readonly strip: Series;
}

const RECOVER_AFTER = 3;
/** With the lost alert off a device still reads Offline after this many lost pings; it just raises no alert. */
const QUIET_OFFLINE_AFTER = 3;
export const STRIP_POINTS = 120;

const duration = (ms: number) => {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} hr`;
};

function alert(level: Alert["level"], stage: string, name: string, address: string, what: string, detail = ""): Alert {
  return {
    level,
    stage,
    message: `${name} (${address}) ${what}${detail ? `: ${detail}` : ""}`,
    title: `${name} ${what}`.slice(0, 120),
    body: detail ? `${address} · ${detail}` : address,
  };
}

export class DeviceWatch {
  history = new History();
  state: DeviceState = "not-checked";
  since: number | null = null;
  private lostRun = 0;
  /** When the current run of lost pings began. */
  private lostSince: number | null = null;
  private underRun = 0;
  private alerted = false;

  constructor(readonly address: string) {}

  private enter(state: DeviceState, at: number) {
    this.state = state;
    this.since = at;
  }

  /** Takes one ping result and returns an alert when the device's state changed in a way worth logging. */
  add(deviceName: string, rules: Rules, at: number, rtt: number | null): Alert | null {
    const starting = this.state === "not-checked";
    const alert = this.take(deviceName, rules, at, rtt);
    return starting ? null : alert;
  }

  private take(deviceName: string, rules: Rules, at: number, rtt: number | null): Alert | null {
    this.history.add(at, rtt);
    const name = deviceName.trim() || this.address;
    const limit = rules.overMs;
    if (rtt === null) {
      this.lostRun++;
      this.lostSince ??= this.history.lastAnswerAt ?? at;
      this.underRun = 0;
      const silentFor = at - this.lostSince;
      const due = rules.lostMs === null ? this.lostRun >= QUIET_OFFLINE_AFTER : silentFor >= rules.lostMs;
      if (this.state !== "offline" && due) {
        this.enter("offline", at);
        this.alerted = rules.lostMs !== null;
        if (this.alerted) return alert("error", "device-offline", name, this.address, "stopped answering", `no answer for ${duration(silentFor)}`);
      }
      return null;
    }
    this.lostRun = 0;
    this.lostSince = null;
    if (this.state === "offline") {
      const away = this.since === null ? 0 : at - this.since;
      const wasAlerted = this.alerted;
      this.alerted = false;
      const slow = limit !== null && rtt > limit;
      this.enter(slow ? "slow" : "online", at);
      if (slow) this.alerted = true;
      if (wasAlerted || slow)
        return slow
          ? alert("error", "device-slow", name, this.address, `is answering again after ${duration(away)}, but slowly`, `${Math.round(rtt)} ms, over its ${limit} ms limit`)
          : alert("info", "device-online", name, this.address, `is answering again after ${duration(away)}`);
      return null;
    }
    if (limit !== null && rtt > limit) {
      this.underRun = 0;
      if (this.state !== "slow") {
        this.enter("slow", at);
        this.alerted = true;
        return alert("error", "device-slow", name, this.address, `answered in ${Math.round(rtt)} ms, over its ${limit} ms limit`);
      }
      return null;
    }
    if (this.state === "slow") {
      // The limit may have been raised or removed while Slow; either way it is under now.
      if (++this.underRun < RECOVER_AFTER && limit !== null) return null;
      const slowFor = this.since === null ? 0 : at - this.since;
      this.alerted = false;
      this.enter("online", at);
      return alert("info", "device-online", name, this.address, `is back under its limit after ${duration(slowFor)}`);
    }
    if (this.state !== "online") this.enter("online", at);
    return null;
  }

  /** Forgets every past result. The device's state stays, so nothing is announced again. */
  clearHistory() {
    this.history = new History();
  }

  summary(spanMs: number, now: number): DeviceSummary {
    const totals = this.history.totals(now - spanMs, now, now);
    const answered = totals.sent - totals.lost;
    const latest = this.history.latest;
    return {
      state: this.state,
      since: this.since,
      now: latest?.rtt === null || latest === null ? null : round(latest.rtt),
      average: answered ? round(totals.sum / answered) : null,
      best: answered ? round(totals.min) : null,
      worst: answered ? round(totals.max) : null,
      jitter: totals.jitterCount ? round(totals.jitterSum / totals.jitterCount) : null,
      lostPct: totals.sent ? Math.round((totals.lost / totals.sent) * 1000) / 10 : null,
      strip: this.history.series(now - spanMs, now, STRIP_POINTS, now),
    };
  }
}
