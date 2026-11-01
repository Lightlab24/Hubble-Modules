import type { GroupPage, GroupEdit } from "../group-page.js";

/** Local projections stay editable while ordered document transactions are pending. */
export class GroupEditQueue {
  private pending: {
    edit: GroupEdit;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  private running = false;
  private epoch = 0;
  constructor(
    private base: GroupPage,
    private readonly save: (edit: GroupEdit) => Promise<GroupPage>,
    private readonly changed: (page: GroupPage) => void,
    private readonly failed: (message: string) => void,
  ) {}
  get busy() {
    return this.pending.length > 0;
  }
  get readEpoch() {
    return this.epoch;
  }
  refresh(page: GroupPage, epoch: number) {
    if (!this.busy && epoch === this.epoch) {
      this.base = page;
      this.publish();
    }
  }
  edit(input: GroupEdit) {
    if (input.contextId !== this.base.contextId)
      throw new Error("Routing context changed");
    this.epoch++;
    const result = new Promise<void>((resolve, reject) =>
      this.pending.push({ edit: input, resolve, reject }),
    );
    this.publish();
    void this.drain();
    return result;
  }
  get snapshot() {
    let page = structuredClone(this.base);
    for (const { edit: input } of this.pending) {
      switch (input.operation) {
        case "add":
          if (!page.groups.some((item) => item.id === input.id))
            page.groups.push({ id: input.id, name: input.name });
          break;
        case "rename":
          page.groups = page.groups.map((item) =>
            item.id === input.id ? { ...item, name: input.name } : item,
          );
          break;
        case "delete":
          page.groups = page.groups.filter((item) => item.id !== input.id);
          break;
        case "automatic-take":
          page.automaticTake = input.enabled;
          break;
      }
    }
    return page;
  }
  private publish() {
    this.changed(this.snapshot);
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const pending = this.pending[0]!,
          input = pending.edit;
        let failure: Error | undefined;
        try {
          this.base = await this.save(input);
        } catch (error) {
          // A failed addition invalidates subsequent edits to that new identity only.
          failure =
            error instanceof Error
              ? error
              : new Error("Routing group change failed");
          if (input.operation === "add")
            this.pending = this.pending.filter((item, index) => {
              if (
                index === 0 ||
                !("id" in item.edit) ||
                item.edit.id !== input.id
              )
                return true;
              item.reject(new Error("The routing group could not be added"));
              return false;
            });
          this.failed(failure.message);
        }
        this.pending.shift();
        this.epoch++;
        this.publish();
        if (failure) pending.reject(failure);
        else pending.resolve();
      }
    } finally {
      this.running = false;
    }
  }
}
