import { z } from "zod";
import type {
  ModuleContext,
  ModuleJsonValue,
  ModuleTableRow,
} from "@hubble/module-sdk";
import type { TslDiscoveredDisplay, TslReceiver } from "./receiver.js";

export const indicatorValues = [
  "default",
  "flag1",
  "flag2",
  "flag3",
  "flag4",
  "left",
  "text",
  "right",
] as const;
export function onAir(
  display: TslDiscoveredDisplay | undefined,
  indicator: string,
): boolean | null {
  if (!display?.fresh) return null;
  if (display.protocol === "3.1") {
    if (indicator !== "default" && !/^flag[1-4]$/u.test(indicator)) return null;
    return (
      display.flags[
        indicator === "default" ? 1 : Number(indicator.slice(4)) - 1
      ] ?? null
    );
  }
  const field = indicator === "default" ? "text" : indicator;
  return field === "left" || field === "text" || field === "right"
    ? display[field] === 1
    : null;
}
const mappingsSchema = z
  .array(
    z.object({
      id: z.string(),
      values: z.object({
        name: z.string(),
        screen: z.int().min(0).max(65534),
        address: z.int().min(0).max(65534),
        indicator: z.enum(indicatorValues),
      }),
    }),
  )
  .max(256);

/** Protocol observations are portable public data; receiver sockets stay in this module. */
export class TslPresentation {
  readonly mappings: z.infer<typeof mappingsSchema>;
  private closed = false;
  private publishing = false;
  private pending: ModuleJsonValue | undefined;
  private feedback = new Map<string, string>();
  constructor(
    private readonly context: ModuleContext,
    private readonly receiver: () => TslReceiver,
  ) {
    this.mappings = mappingsSchema.parse(
      context.settings.feedbackMappings ?? [],
    );
  }
  shared(): ModuleJsonValue {
    const state = this.receiver().snapshot();
    // Compact tuples keep all 4096 discoveries below the public data limit.
    return {
      phase: state.phase,
      protocol: this.context.settings.protocol ?? "3.1",
      displays: state.displays.map((d) => [
        d.screen,
        d.address,
        d.flags.reduce((mask, flag, i) => mask | (flag ? 1 << i : 0), 0),
        d.left,
        d.text,
        d.right,
        d.fresh,
        d.sequence,
      ]),
    };
  }
  emit(): void {
    if (this.closed) return;
    const state = this.receiver().snapshot();
    const rows: ModuleTableRow[] = state.displays.slice(-512).map((d) => ({
      id: `display-${d.screen}-${d.address}`,
      values: {
        screen: d.screen,
        address: d.address,
        label: d.label.slice(0, 256),
        tally:
          d.protocol === "3.1"
            ? d.flags
                .map((flag, i) => (flag ? `T${i + 1}` : ""))
                .filter(Boolean)
                .join(" ") || "Off"
            : `L:${d.left} Text:${d.text} R:${d.right}`,
        status: d.fresh ? "Receiving" : "Unavailable",
        sender: `${d.sourceAddress}:${d.sourcePort}`,
      },
    }));
    this.context.publishState({
      phase:
        state.phase === "listening"
          ? "ready"
          : state.phase === "error"
            ? "error"
            : "unavailable",
      message: state.error,
      observedAt: new Date().toISOString(),
      values: {
        listener: `${this.context.settings.transport ?? "udp"} ${this.context.settings.bindAddress ?? "0.0.0.0"}:${this.context.settings.port ?? 9821}`,
        received: state.displays.length,
        invalidPackets: state.invalidPackets,
        discovery: rows,
        discoveryNote:
          state.displays.length > 512
            ? "Showing the latest 512 displays; all addresses remain available for feedback and routing."
            : "Waiting for tally",
        feedbackStatus: {
          settings: JSON.parse(JSON.stringify(this.context.settings)),
          rows: this.mappings.map((row) => ({
            id: row.id,
            values: {
              status: this.status(
                row.values.screen,
                row.values.address,
                row.values.indicator,
              ),
            },
          })),
        },
      },
    });
    for (const row of this.mappings) {
      const display = this.receiver().resolve(
        row.values.screen,
        row.values.address,
      );
      const active = onAir(display, row.values.indicator);
      const value = {
        id: "tally",
        fields: { mappingId: row.id },
        state:
          active === null
            ? ("unavailable" as const)
            : active
              ? ("active" as const)
              : ("inactive" as const),
        observedAt: display ? new Date(display.lastSeen).toISOString() : null,
      };
      const key = JSON.stringify(value);
      if (this.feedback.get(row.id) !== key) {
        this.feedback.set(row.id, key);
        this.context.publishFeedback(value);
      }
    }
    this.pending = this.shared();
    void this.flush();
  }
  private status(screen: number, address: number, indicator: string): string {
    const active = onAir(this.receiver().resolve(screen, address), indicator);
    return active === null ? "Waiting for tally" : active ? "ON AIR" : "Off";
  }
  private async flush(): Promise<void> {
    if (this.publishing || !this.context.modules) return;
    this.publishing = true;
    try {
      while (this.pending !== undefined && !this.closed) {
        const value = this.pending;
        this.pending = undefined;
        await this.context.modules.publish("tally", 1, value);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      this.context.log({
        level: "error",
        stage: "publish-tally",
        message:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Tally publication failed",
      });
    } finally {
      this.publishing = false;
    }
  }
  close(): void {
    this.closed = true;
    this.pending = undefined;
  }
}
