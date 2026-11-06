import { GroupPageSchema, type GroupPage } from "../group-page.js";
import { GroupEditQueue } from "./group-edit-queue.js";
import type { PageBridge } from "./page-client.js";

export interface AutomaticTakeRow {
  readonly contextId: string;
  readonly name: string;
  readonly automaticTake: boolean;
}

/** One ordered save queue per routing context, so a toggle never waits to show its result. */
export class AutomaticTakeSettingsModel {
  private readonly queues = new Map<string, GroupEditQueue>();
  private readonly pages = new Map<string, GroupPage>();
  private order: readonly GroupPage["contexts"][number][] = [];

  constructor(
    private readonly bridge: PageBridge,
    private readonly changed: (rows: readonly AutomaticTakeRow[]) => void,
    private readonly failed: (message: string) => void,
  ) {}

  get rows(): readonly AutomaticTakeRow[] {
    return this.order.flatMap((context) => {
      const page = this.pages.get(context.contextId);
      return page
        ? [
            {
              contextId: context.contextId,
              name: context.name,
              automaticTake: page.automaticTake,
            },
          ]
        : [];
    });
  }

  private async read(contextId: string | null): Promise<GroupPage> {
    return GroupPageSchema.parse(await this.bridge.call("groups", contextId));
  }

  private apply(page: GroupPage, epoch: number | undefined): void {
    const id = page.contextId;
    if (!id) return;
    const queue = this.queues.get(id);
    if (queue) {
      // refresh() ignores an older read while a newer local edit is pending.
      if (epoch !== undefined) queue.refresh(page, epoch);
      return;
    }
    this.pages.set(id, page);
    this.queues.set(
      id,
      new GroupEditQueue(
        page,
        async (input) =>
          GroupPageSchema.parse(await this.bridge.call("edit-group", input)),
        (next) => {
          this.pages.set(id, next);
          this.changed(this.rows);
        },
        this.failed,
      ),
    );
  }

  async load(): Promise<void> {
    const epochs = new Map(
      [...this.queues].map(([id, queue]) => [id, queue.readEpoch]),
    );
    const first = await this.read(null);
    const others = await Promise.all(
      first.contexts
        .filter((context) => context.contextId !== first.contextId)
        .map((context) => this.read(context.contextId)),
    );
    this.order = first.contexts;
    for (const page of [first, ...others])
      this.apply(page, page.contextId ? epochs.get(page.contextId) : undefined);
    this.changed(this.rows);
  }

  setAutomaticTake(contextId: string, enabled: boolean): void {
    // The queue reports a failed save through failed() and rolls the row back.
    void this.queues
      .get(contextId)
      ?.edit({ operation: "automatic-take", contextId, enabled })
      .catch(() => {});
  }
}

/** Calls reload when the published routing document revision changes after the first value. */
export function followRoutingRevision(reload: () => void) {
  let seen: unknown;
  let initial = true;
  return (state: unknown): void => {
    if (typeof state !== "object" || state === null) return;
    const values = (state as { values?: Record<string, unknown> }).values;
    const revision = values?.routingGroupsRevision;
    if (revision === undefined) return;
    if (!initial && revision !== seen) reload();
    initial = false;
    seen = revision;
  };
}
