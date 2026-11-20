/**
 * One device's ping history, held in memory only. Results are counted into
 * 0.2-second buckets for the last fifteen minutes (one per ping at the fastest
 * ping time), one-second buckets for the last two hours and ten-second buckets
 * for the last day, so a day of history costs the same whatever the ping time is.
 */
export interface Totals {
  sent: number;
  lost: number;
  /** Sum, least and most of the answered pings' times, in ms. */
  sum: number;
  min: number;
  max: number;
  /** Sum and count of the changes between one answer and the next, for jitter. */
  jitterSum: number;
  jitterCount: number;
}
export interface Series {
  /** Start of the first bin, ms since 1970. */
  readonly from: number;
  readonly stepMs: number;
  readonly sent: number[];
  readonly lost: number[];
  /** Average and worst answer per bin; null where nothing answered. */
  readonly avg: (number | null)[];
  readonly max: (number | null)[];
}

const emptyTotals = (): Totals => ({ sent: 0, lost: 0, sum: 0, min: Infinity, max: 0, jitterSum: 0, jitterCount: 0 });

class Tier {
  private readonly slot: Float64Array;
  private readonly sent: Uint16Array;
  private readonly lost: Uint16Array;
  private readonly sum: Float32Array;
  private readonly min: Float32Array;
  private readonly max: Float32Array;
  private readonly jitterSum: Float32Array;
  private readonly jitterCount: Uint16Array;

  constructor(
    readonly stepMs: number,
    readonly size: number,
  ) {
    this.slot = new Float64Array(size).fill(-1);
    this.sent = new Uint16Array(size);
    this.lost = new Uint16Array(size);
    this.sum = new Float32Array(size);
    this.min = new Float32Array(size);
    this.max = new Float32Array(size);
    this.jitterSum = new Float32Array(size);
    this.jitterCount = new Uint16Array(size);
  }

  add(at: number, rtt: number | null, jitter: number | null) {
    const bucket = Math.floor(at / this.stepMs);
    const index = bucket % this.size;
    if (this.slot[index] !== bucket) {
      this.slot[index] = bucket;
      this.sent[index] = this.lost[index] = this.jitterCount[index] = 0;
      this.sum[index] = this.max[index] = this.jitterSum[index] = 0;
      this.min[index] = Infinity;
    }
    if (this.sent[index]! < 65_535) this.sent[index]!++;
    if (rtt === null) {
      if (this.lost[index]! < 65_535) this.lost[index]!++;
      return;
    }
    this.sum[index]! += rtt;
    if (rtt < this.min[index]!) this.min[index] = rtt;
    if (rtt > this.max[index]!) this.max[index] = rtt;
    if (jitter !== null && this.jitterCount[index]! < 65_535) {
      this.jitterSum[index]! += jitter;
      this.jitterCount[index]!++;
    }
  }

  /** Adds this tier's buckets from `fromBucket` up to but not including `toBucket` into `into`. */
  collect(fromBucket: number, toBucket: number, into: Totals) {
    for (let bucket = fromBucket; bucket < toBucket; bucket++) {
      const index = ((bucket % this.size) + this.size) % this.size;
      if (this.slot[index] !== bucket) continue;
      into.sent += this.sent[index]!;
      into.lost += this.lost[index]!;
      into.sum += this.sum[index]!;
      if (this.min[index]! < into.min) into.min = this.min[index]!;
      if (this.max[index]! > into.max) into.max = this.max[index]!;
      into.jitterSum += this.jitterSum[index]!;
      into.jitterCount += this.jitterCount[index]!;
    }
  }
}

export const PING_STEP_MS = 200;
export const PING_SPAN_MS = 15 * 60 * 1000;
export const FINE_STEP_MS = 1000;
export const COARSE_STEP_MS = 10_000;
export const FINE_SPAN_MS = 2 * 60 * 60 * 1000;
export const HISTORY_SPAN_MS = 24 * 60 * 60 * 1000;

export class History {
  private readonly ping = new Tier(PING_STEP_MS, PING_SPAN_MS / PING_STEP_MS);
  private readonly fine = new Tier(FINE_STEP_MS, FINE_SPAN_MS / FINE_STEP_MS);
  private readonly coarse = new Tier(COARSE_STEP_MS, HISTORY_SPAN_MS / COARSE_STEP_MS);
  private previous: number | null = null;
  /** The newest result: its time, and its answer time or null when lost. */
  latest: { at: number; rtt: number | null } | null = null;
  /** When the newest answer arrived, or null before any. */
  lastAnswerAt: number | null = null;

  add(at: number, rtt: number | null) {
    const jitter = rtt !== null && this.previous !== null ? Math.abs(rtt - this.previous) : null;
    if (rtt !== null) {
      this.previous = rtt;
      this.lastAnswerAt = at;
    }
    this.ping.add(at, rtt, jitter);
    this.fine.add(at, rtt, jitter);
    this.coarse.add(at, rtt, jitter);
    this.latest = { at, rtt };
  }

  /** The coarsest tier that is still at least as fine as `stepMs` and holds everything back to `from`, as seen at `now`. */
  private tierFor(from: number, now: number, stepMs: number) {
    if (stepMs >= COARSE_STEP_MS || from < now - FINE_SPAN_MS + FINE_STEP_MS) return this.coarse;
    if (stepMs >= FINE_STEP_MS || from < now - PING_SPAN_MS + PING_STEP_MS) return this.fine;
    return this.ping;
  }

  /** Everything after `from`, up to and including the bucket `to` falls in. */
  totals(from: number, to: number, now: number): Totals {
    const tier = this.tierFor(from, now, FINE_STEP_MS);
    const totals = emptyTotals();
    tier.collect(Math.floor(from / tier.stepMs) + 1, Math.floor(to / tier.stepMs) + 1, totals);
    return totals;
  }

  /** The time after `from`, up to and including `to`, cut into about `points` equal bins of whole buckets. */
  series(from: number, to: number, points: number, now: number, minStepMs = FINE_STEP_MS): Series {
    // Never finer than the ping time: a bin with no ping in it would leave a gap between bars.
    const wanted = Math.max(minStepMs, (to - from) / Math.max(1, points));
    const tier = this.tierFor(from, now, wanted);
    const stepMs = Math.max(1, Math.ceil(wanted / tier.stepMs)) * tier.stepMs;
    const first = Math.floor(from / stepMs) + 1;
    const count = Math.min(4096, Math.max(1, Math.floor(to / stepMs) + 1 - first));
    const per = stepMs / tier.stepMs;
    const out: Series = { from: first * stepMs, stepMs, sent: [], lost: [], avg: [], max: [] };
    for (let bin = 0; bin < count; bin++) {
      const totals = emptyTotals();
      const start = (first + bin) * per;
      tier.collect(start, start + per, totals);
      const answered = totals.sent - totals.lost;
      out.sent.push(totals.sent);
      out.lost.push(totals.lost);
      out.avg.push(answered > 0 ? round(totals.sum / answered) : null);
      out.max.push(answered > 0 ? round(totals.max) : null);
    }
    return out;
  }
}

export const round = (value: number) => Math.round(value * 100) / 100;
