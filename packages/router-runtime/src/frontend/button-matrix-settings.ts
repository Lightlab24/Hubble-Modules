import { GroupPageSchema, type GroupPage } from "../group-page.js";
import { GroupEditQueue } from "./group-edit-queue.js";
import type { PageBridge } from "./page-client.js";

/** The routing document refuses more than this many groups per context. */
export const MAX_ROUTING_GROUPS = 64;

export interface ButtonMatrixSettingsRow {
  readonly contextId: string;
  readonly name: string;
  readonly automaticTake: boolean;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
}

/** The first "Group N" name no group in this context already uses. */
export function nextGroupName(
  groups: readonly { readonly name: string }[],
): string {
  const used = new Set(
    groups.map(({ name }) => name.trim().toLocaleLowerCase("en-US")),
  );
  let index = 1;
  while (used.has(`group ${String(index)}`)) index++;
  return `Group ${String(index)}`;
}

/**
 * The Button Matrix's Automatic Take and routing groups for every routing
 * context, with one ordered save queue per context so an edit shows at once.
 */
export class ButtonMatrixSettingsModel {
  private readonly queues = new Map<string, GroupEditQueue>();
  private readonly pages = new Map<string, GroupPage>();
  private order: readonly GroupPage["contexts"][number][] = [];

  constructor(
    private readonly bridge: PageBridge,
    private readonly changed: (rows: readonly ButtonMatrixSettingsRow[]) => void,
    private readonly failed: (message: string) => void,
    private readonly createId: () => string,
  ) {}

  get rows(): readonly ButtonMatrixSettingsRow[] {
    return this.order.flatMap((context) => {
      const page = this.pages.get(context.contextId);
      return page
        ? [
            {
              contextId: context.contextId,
              name: context.name,
              automaticTake: page.automaticTake,
              groups: page.groups,
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

  // Each queue reports a failed save through failed() and rolls the edit back.

  setAutomaticTake(contextId: string, enabled: boolean): void {
    void this.queues
      .get(contextId)
      ?.edit({ operation: "automatic-take", contextId, enabled })
      .catch(() => {});
  }

  addGroup(contextId: string): void {
    const queue = this.queues.get(contextId);
    const groups = this.pages.get(contextId)?.groups ?? [];
    if (!queue || groups.length >= MAX_ROUTING_GROUPS) return;
    void queue
      .edit({
        operation: "add",
        contextId,
        id: this.createId(),
        name: nextGroupName(groups),
      })
      .catch(() => {});
  }

  renameGroup(contextId: string, id: string, name: string): Promise<void> {
    const queue = this.queues.get(contextId);
    if (!queue) return Promise.reject(new Error("Routing context changed"));
    return queue.edit({ operation: "rename", contextId, id, name });
  }

  deleteGroup(contextId: string, id: string): void {
    void this.queues
      .get(contextId)
      ?.edit({ operation: "delete", contextId, id })
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
