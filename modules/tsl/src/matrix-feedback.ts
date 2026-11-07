import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  decodeModuleChoice,
  moduleFeedbackKey,
  type ModuleContext,
  type ModuleFeedbackSubscription,
  type ModuleFeedbackAppearance,
  type ModulePeer,
  type ModuleValues,
} from "@hubble/module-sdk";
import { matrix } from "./matrix.js";
import type { TslReceiver } from "./receiver.js";

const Settings = z.object({
  indicationEnabled: z.boolean().default(true),
  programFlag: z.int().min(1).max(4).default(2),
  redFields: z
    .array(z.enum(["left", "text", "right"]))
    .min(1)
    .default(["text"]),
  cycleMs: z.int().min(500).max(10000).default(2000),
});
const Input = z.object({
  actionColumnId: z.string().uuid(),
  actionId: z.string(),
  values: z.record(z.string(), z.json()),
  settings: Settings,
});
const Stored = z.object({
  following: z.boolean().default(true),
  columns: z.record(z.string().uuid(), z.boolean()).default({}),
});
type Input = z.infer<typeof Input>;
const editor = matrix.fields.find(
  (field) => field.id === "actionType",
)!.choiceEditor!;
const brighten = (color: string) =>
  `#${[1, 3, 5]
    .map((start) => {
      const value = parseInt(color.slice(start, start + 2), 16);
      return Math.round(value + (255 - value) * 0.35)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")
    .toUpperCase()}`;

/** Protocol decisions and follow persistence belong to this independently updated worker. */
export class MatrixFeedback {
  private subscriptions: {
    request: ModuleFeedbackSubscription;
    input: Input;
  }[] = [];
  private signatures = new Map<string, string>();
  private state = Stored.parse({});
  private writes = Promise.resolve();
  private closed = false;
  private peer: ModulePeer | undefined;
  private peerState: boolean | null = null;
  private peerRefreshPending = false;
  private peerTimer: ReturnType<typeof setInterval> | undefined;
  private peerUnsubscribe: (() => Promise<void>) | undefined;
  private async refreshPeer(): Promise<void> {
    const exchange = this.context.modules;
    if (!exchange || this.closed || this.peerRefreshPending) return;
    this.peerRefreshPending = true;
    try {
      const bindings = (await exchange.bindings()).filter(
        (binding) =>
          binding.target.moduleId === "hubble-tally-switch" &&
          binding.allowActions &&
          !binding.unresolved,
      );
      const target = this.context.settings.routingPeer
        ? bindings.find(
            (binding) =>
              binding.target.kind === "connection" &&
              binding.target.connectionId === this.context.settings.routingPeer,
          )?.target
        : bindings.length === 1
          ? bindings[0]!.target
          : undefined;
      if (
        JSON.stringify(target) !== JSON.stringify(this.peer) ||
        (target && !this.peerUnsubscribe)
      ) {
        await this.peerUnsubscribe?.();
        this.peerUnsubscribe = undefined;
        this.peer = target;
        this.peerState = null;
        if (target)
          this.peerUnsubscribe = await exchange.subscribe(
            { kind: "data", target, id: "following", version: 1 },
            (event) => {
              if (this.closed) return;
              if (event.kind === "availability" && !event.available)
                this.peerState = null;
              if (event.kind === "data")
                this.peerState = z
                  .object({ following: z.boolean() })
                  .parse(event.value).following;
              this.emit();
            },
          );
      }
      this.peerState = target
        ? z.object({ following: z.boolean() }).parse(
            await exchange.query(target, {
              id: "following",
              version: 1,
              input: null,
            }),
          ).following
        : null;
    } catch {
      this.peerState = null;
    } finally {
      this.peerRefreshPending = false;
      this.emit();
    }
  }
  private readonly file: string | undefined;
  constructor(
    private readonly context: ModuleContext,
    private readonly receiver: () => TslReceiver,
  ) {
    this.file = context.runtimeDirectory
      ? path.join(context.runtimeDirectory, "matrix-following.json")
      : undefined;
  }
  async start(): Promise<void> {
    this.peerTimer = setInterval(() => void this.refreshPeer(), 1000);
    this.peerTimer.unref();
    void this.refreshPeer();
    if (!this.file) return;
    try {
      const text = await readFile(this.file, "utf8");
      if (text.length > 65536)
        throw new Error("Invalid saved Tally follow state");
      this.state = Stored.parse(JSON.parse(text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const legacy = await readFile(
          path.join(path.dirname(this.file), "legacy-runtime.json"),
          "utf8",
        );
        if (legacy.length > 65536)
          throw new Error("Invalid legacy Tally state");
        this.state = Stored.parse(JSON.parse(legacy));
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(this.file, JSON.stringify(this.state), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  subscribe(requests: readonly ModuleFeedbackSubscription[]): void {
    this.subscriptions = requests
      .filter((request) => request.id === "matrix")
      .map((request) => ({ request, input: Input.parse(request.fields) }));
    this.signatures.clear();
    this.emit();
  }
  columns(): string[] {
    return [
      ...new Set(this.subscriptions.map((item) => item.input.actionColumnId)),
    ];
  }
  private enabled(input: Input): boolean {
    return (
      this.state.following &&
      (this.state.columns[input.actionColumnId] ??
        input.settings.indicationEnabled)
    );
  }
  emit(): void {
    if (this.closed || this.subscriptions.length === 0) return;
    const health = this.receiver().health();
    for (const { request, input } of this.subscriptions) {
      const choice = decodeModuleChoice(
        editor,
        String(input.values.actionType ?? ""),
      );
      let active: boolean | null = null;
      const appearance: ModuleFeedbackAppearance = {
        backgroundColor: null,
        glow: null,
        cells: {},
      };
      if (choice && input.values.enabled !== false) {
        const observer = choice.value === "tally-feedback";
        if (observer) {
          const address = z
            .int()
            .min(0)
            .max(65534)
            .safeParse(input.values.tallyAddress);
          const screen = z
            .int()
            .min(0)
            .max(65534)
            .safeParse(input.values.tallyScreen);
          const display =
            address.success && screen.success
              ? this.receiver().resolve(screen.data, address.data)
              : undefined;
          if (health.phase === "listening" && display?.fresh)
            active =
              this.enabled(input) &&
              (display.protocol === "3.1"
                ? display.flags[input.settings.programFlag - 1] === true
                : input.settings.redFields.some(
                    (field) => display[field] === 1,
                  ));
          appearance.cells = {
            tallyAddress: {
              color: active === true ? "#B91C1C" : null,
              label:
                `${String(input.values.tallyAddress ?? "")}${display?.label ? ` · ${display.label}` : ""}`.slice(
                  0,
                  160,
                ),
            },
          };
        } else if (
          choice.value.startsWith("button-tally") ||
          choice.value === "follow-tally"
        )
          active = this.enabled(input);
        else if (choice.value.startsWith("tally-switch"))
          active = this.peerState;
        const feedback = choice.parameters.feedback;
        const enabled = feedback !== false && feedback !== "off";
        const colors = Array.isArray(choice.parameters.colors)
          ? (choice.parameters.colors as string[])
          : typeof choice.parameters.colors === "string"
            ? choice.parameters.colors.split("|")
            : ["#B91C1C", "#000000"];
        const glow =
          choice.parameters.glow === true || choice.parameters.glow === "on";
        if (active !== null && enabled) {
          if (!observer || choice.explicit)
            appearance.backgroundColor = active
              ? (colors[0] ?? "#B91C1C")
              : (colors[1] ?? "#000000");
          const override = Number(input.values.glowCycleMs ?? 0);
          const cycleMs = override === 0 ? input.settings.cycleMs : override;
          if (active && glow && cycleMs >= 500 && cycleMs <= 10000)
            appearance.glow = {
              color:
                observer && !choice.explicit
                  ? "#FF0000"
                  : brighten(colors[0] ?? "#B91C1C"),
              cycleMs,
            };
          if (observer && appearance.cells?.tallyAddress)
            appearance.cells.tallyAddress.color = active
              ? choice.explicit
                ? (colors[0] ?? null)
                : "#B91C1C"
              : null;
        } else if (observer && appearance.cells?.tallyAddress)
          appearance.cells.tallyAddress.color = null;
      }
      const state =
        active === null ? "unavailable" : active ? "active" : "inactive";
      const signature = JSON.stringify([state, appearance]),
        key = moduleFeedbackKey(request.id, request.fields);
      if (this.signatures.get(key) === signature) continue;
      this.signatures.set(key, signature);
      this.context.publishFeedback({
        ...request,
        state,
        appearance,
        observedAt: new Date().toISOString(),
      });
    }
  }
  async executeLegacy(action: {
    type: string;
    actionId: string;
    actionColumnId: string;
    followMode?: string;
    targetColumnId?: string;
    indication?: boolean;
  }): Promise<void> {
    const input = this.subscriptions.find(
      (item) => item.input.actionColumnId === action.actionColumnId,
    )?.input;
    await this.execute({
      actionColumnId: action.actionColumnId,
      actionId: action.actionId,
      settings: input?.settings ?? Settings.parse({}),
      values: {
        actionType:
          action.type === "tsl.follow"
            ? "follow-tally"
            : action.type === "tsl.tally-switch"
              ? "tally-switch"
              : "set-indication",
        followMode: action.followMode ?? "follow",
        targetColumnId: action.targetColumnId ?? action.actionColumnId,
        indication: action.indication ?? true,
      },
    });
  }
  async execute(fields: ModuleValues, signal?: AbortSignal): Promise<void> {
    const input = Input.parse(fields),
      choice = decodeModuleChoice(
        editor,
        String(input.values.actionType ?? ""),
      );
    if (!choice) throw new Error("Choose a valid Tally action");
    if (choice.value === "tally-feedback" || choice.value === "") return;
    const mode =
      choice.value === "follow-tally" || choice.value === "tally-switch"
        ? String(input.values.followMode)
        : choice.value.split("-").at(-1);
    if (choice.value.startsWith("tally-switch")) {
      const exchange = this.context.modules;
      await this.refreshPeer();
      if (!exchange || !this.peer)
        throw new Error(
          "Add a TALLY Switch module, or choose one in this module's settings",
        );
      const result = await exchange.execute(
        this.peer,
        "follow",
        { mode: z.enum(["follow", "unfollow", "toggle"]).parse(mode) },
        signal,
      );
      if (result.status !== "success") throw new Error(result.message);
      await this.refreshPeer();
      return;
    }
    const target =
      choice.value === "set-indication"
        ? z.string().uuid().parse(input.values.targetColumnId)
        : input.actionColumnId;
    if (
      !this.subscriptions.some((item) => item.input.actionColumnId === target)
    ) {
      if (choice.value !== "set-indication" || !this.context.modules)
        throw new Error("Target Tally column is unavailable");
      const exchange = this.context.modules;
      for (const binding of await exchange.bindings()) {
        if (
          !binding.allowActions ||
          binding.unresolved ||
          binding.target.moduleId !== "hubble-tsl"
        )
          continue;
        const columns = z.array(z.string().uuid()).parse(
          await exchange.query(binding.target, {
            id: "matrix-columns",
            version: 1,
            input: null,
          }),
        );
        if (!columns.includes(target)) continue;
        const result = await exchange.execute(
          binding.target,
          "set-column-indication",
          {
            columnId: target,
            enabled: z.boolean().parse(input.values.indication),
          },
          signal,
        );
        if (result.status !== "success") throw new Error(result.message);
        return;
      }
      throw new Error(
        "Target Tally column is unavailable; check that its receiver is on",
      );
    }
    const saving = this.writes.then(async () => {
      signal?.throwIfAborted();
      if (this.closed) throw new Error("Tally module stopped");
      const next = structuredClone(this.state);
      if (!next.following) {
        for (const { input } of this.subscriptions)
          next.columns[input.actionColumnId] = false;
        next.following = true;
      }
      next.columns[target] =
        choice.value === "set-indication"
          ? z.boolean().parse(input.values.indication)
          : mode === "toggle"
            ? !this.enabled(input)
            : mode === "follow";
      if (this.file) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, JSON.stringify(next), {
          mode: 0o600,
        });
        await rename(`${this.file}.tmp`, this.file);
      }
      if (this.closed) return;
      this.state = next;
      this.emit();
    });
    this.writes = saving.catch(() => {});
    await saving;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.peerTimer);
    await this.peerUnsubscribe?.();
    await this.writes;
    this.subscriptions = [];
    this.signatures.clear();
  }
}
