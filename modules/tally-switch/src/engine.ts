import { z } from "zod";

export const indicators = [
  "default",
  "flag1",
  "flag2",
  "flag3",
  "flag4",
  "left",
  "text",
  "right",
] as const;
export const rowsSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(96),
      values: z.object({
        name: z.string().max(160),
        enabled: z.boolean(),
        receiver: z.string(),
        screen: z.int().min(0).max(65534),
        address: z.int().min(0).max(65534),
        indicator: z.enum(indicators),
        router: z.string(),
        source: z.int().min(1).max(65536),
        destination: z.int().min(1).max(65536),
        level: z.int().min(1).max(256),
      }),
    }),
  )
  .max(512);
export type Mapping = z.infer<typeof rowsSchema>[number];
export const tallySchema = z.object({
  phase: z.string(),
  protocol: z.enum(["3.1", "5.0"]),
  displays: z
    .array(
      z.tuple([
        z.int().min(0).max(65535),
        z.int().min(0).max(65535),
        z.int().min(0).max(15),
        z.int().min(0).max(3),
        z.int().min(0).max(3),
        z.int().min(0).max(3),
        z.boolean(),
        z.int().nonnegative(),
      ]),
    )
    .max(4096),
});
export type Tally = z.infer<typeof tallySchema>;
export type Route = {
  router: string;
  source: number;
  destination: number;
  level: number;
};
export type RowStatus = {
  id: string;
  values: { status: string; program: string };
};
export function program(
  tally: Tally | undefined,
  row: Mapping["values"],
): boolean | null {
  if (!tally || tally.phase !== "listening") return null;
  if (tally.protocol === "3.1" && (row.screen !== 0 || row.address > 126))
    return null;
  const entry = tally.displays
    .filter(
      (d) =>
        (d[0] === row.screen || d[0] === 65535) &&
        (d[1] === row.address || d[1] === 65535),
    )
    .sort((a, b) => b[7] - a[7])[0];
  if (!entry?.[6]) return null;
  if (tally.protocol === "3.1") {
    if (row.indicator !== "default" && !row.indicator.startsWith("flag"))
      return null;
    return !!(
      entry[2] &
      (1 <<
        (row.indicator === "default" ? 1 : Number(row.indicator.slice(4)) - 1))
    );
  }
  const index =
    row.indicator === "left"
      ? 3
      : row.indicator === "default" || row.indicator === "text"
        ? 4
        : row.indicator === "right"
          ? 5
          : null;
  return index === null ? null : entry[index] === 1;
}

/** One decision per output. Uncertain results and reconnects never replay a command. */
export class TallySwitchEngine {
  readonly tallies = new Map<string, Tally>();
  readonly routers = new Map<string, { ready: boolean; approved: boolean }>();
  private readonly attempts = new Map<
    string,
    { signature: string; status: string }
  >();
  private readonly initialized = new Set<string>();
  private readonly inFlight = new Set<string>();
  private closed = false;
  private generation = 0;
  statuses: RowStatus[] = [];
  constructor(
    readonly rows: Mapping[],
    public following: boolean,
    private readonly route: (input: Route) => Promise<string>,
    private readonly changed: () => void,
  ) {}
  setFollowing(value: boolean): void {
    this.following = value;
    this.generation++;
    // Explicit operator follow may catch up, unlike automatic startup or reconnection.
    if (value) {
      this.attempts.clear();
      for (const row of this.rows) this.initialized.add(this.key(row));
    }
    this.evaluate(value);
  }
  close(): void {
    this.closed = true;
    this.generation++;
  }
  baseline(bindingId: string): void {
    for (const row of this.rows)
      if (row.values.receiver === bindingId || row.values.router === bindingId)
        this.initialized.delete(this.key(row));
  }
  private key(row: Mapping): string {
    return JSON.stringify([
      row.values.router,
      row.values.destination,
      row.values.level,
    ]);
  }
  evaluate(allowDispatch: boolean): void {
    if (this.closed) return;
    const status = new Map<string, RowStatus>();
    const set = (row: Mapping, message: string, active: boolean | null) =>
      status.set(row.id, {
        id: row.id,
        values: {
          status: message,
          program: active === null ? "Unknown" : active ? "ON AIR" : "Off",
        },
      });
    const groups = new Map<string, Mapping[]>();
    for (const row of this.rows) {
      const active = program(this.tallies.get(row.values.receiver), row.values);
      if (!row.values.enabled || !this.following) {
        set(row, this.following ? "Row disabled" : "Unfollowing", active);
        continue;
      }
      const key = this.key(row);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const [key, rows] of groups) {
      const samples = rows.map((row) => ({
        row,
        active: program(this.tallies.get(row.values.receiver), row.values),
      }));
      const active = samples.filter((sample) => sample.active === true);
      const unknown = samples.some(
        (sample) =>
          sample.active === null ||
          !sample.row.values.receiver ||
          !sample.row.values.router,
      );
      if (unknown || active.length !== 1) {
        const message = unknown
          ? "Holding · waiting for every mapped camera"
          : active.length > 1
            ? "Holding · multiple cameras on air"
            : "Holding · no camera on air";
        for (const sample of samples) set(sample.row, message, sample.active);
        // Once all off is observed, the next on-air transition is a fresh decision.
        if (!unknown && active.length === 0) {
          this.initialized.add(key);
          this.attempts.delete(key);
        }
        continue;
      }
      const winner = active[0]!.row;
      const signature = JSON.stringify([winner.id, winner.values.source]);
      for (const sample of samples)
        set(sample.row, "Waiting for program tally", sample.active);
      if (!this.initialized.has(key)) {
        this.initialized.add(key);
        this.attempts.set(key, {
          signature,
          status: "Holding · startup tally observed; waiting for a change",
        });
      }
      const router = this.routers.get(winner.values.router);
      if (!router?.ready || !router.approved) {
        set(winner, "Holding · router unavailable", true);
        continue;
      }
      const previous = this.attempts.get(key);
      if (previous?.signature === signature) {
        set(winner, previous.status, true);
        continue;
      }
      if (!allowDispatch || this.inFlight.has(key)) {
        set(winner, "Holding · waiting for a fresh tally update", true);
        continue;
      }
      const attempt = {
        signature,
        status: `Routing source ${winner.values.source} → output ${winner.values.destination}`,
      };
      this.attempts.set(key, attempt);
      this.inFlight.add(key);
      set(winner, attempt.status, true);
      const generation = this.generation;
      void this.route({
        router: winner.values.router,
        source: winner.values.source,
        destination: winner.values.destination,
        level: winner.values.level,
      })
        .then(
          (message) => {
            if (
              !this.closed &&
              this.generation === generation &&
              this.attempts.get(key) === attempt
            )
              attempt.status = message;
          },
          (error) => {
            if (
              !this.closed &&
              this.generation === generation &&
              this.attempts.get(key) === attempt
            )
              attempt.status = `Route failed · ${error instanceof Error ? error.message.slice(0, 180) : "Unknown result"}`;
          },
        )
        .finally(() => {
          this.inFlight.delete(key);
          this.evaluate(true);
        });
    }
    this.statuses = this.rows.flatMap((row) => status.get(row.id) ?? []);
    this.changed();
  }
}
