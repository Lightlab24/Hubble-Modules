import { LeftAlone } from "./merge.js";
import { applyMutation, clone, inverse, type CellEdit, type MonitorDocument, type Mutation } from "./model.js";

export interface SaveReceipt {
  document: MonitorDocument;
  revision: string | null;
  /** What this save changed that another window had also changed (see merge.ts). */
  clashes?: string[];
}
export interface InvalidDraft {
  edit: CellEdit;
  message: string;
}
interface Pending {
  id: number;
  operation: Mutation;
  /** The Undo or Redo entry this change put on a stack, taken off again if the change is refused. */
  entry?: Mutation;
}

/**
 * The page's copy of the monitor list. An edit shows at once and saves in
 * order behind earlier ones. A save that fails rolls back on its own, later
 * edits are replayed over what did save, and a rejected cell keeps its typed
 * value in red so it can be corrected.
 *
 * Several copies of the page can be open at once, one per HubDash window. Each change is sent as
 * what this copy saw and what it wants, and the worker puts it onto the list as saved now, so a
 * copy that is behind another is not refused for that. A save's answer brings the whole saved
 * list back, and `observe` takes a newer one another window saved (see followSaved).
 */
export class DraftStore {
  document: MonitorDocument;
  base: MonitorDocument;
  revision: string | null;
  /** Counts each new saved list this copy takes, so a read that crossed a save can be told apart. */
  epoch = 0;
  pending: Pending[] = [];
  invalid = new Map<string, InvalidDraft>();
  undo: Mutation[] = [];
  redo: Mutation[] = [];
  error = "";
  private next = 0;
  private running = false;
  private listeners = new Set<() => void>();
  private settledListeners = new Set<(refused: boolean) => void>();
  private clashListeners = new Set<(clashes: string[]) => void>();
  private saved: (() => void)[] = [];
  private lastEdit = new Map<string, number>();
  /** Why the last change refused here was refused. */
  private failure: unknown;

  constructor(
    initial: SaveReceipt,
    private save: (operation: Mutation) => Promise<SaveReceipt>,
  ) {
    this.document = clone(initial.document);
    this.base = clone(initial.document);
    this.revision = initial.revision;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Called each time every waiting save has been answered; `refused` if one of them was refused. */
  onSettled(listener: (refused: boolean) => void) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }
  /** Called with what a save changed that another window had also changed. */
  onClash(listener: (clashes: string[]) => void) {
    this.clashListeners.add(listener);
    return () => this.clashListeners.delete(listener);
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  /** Resolves once nothing is waiting to save. */
  whenSaved(): Promise<void> {
    return this.pending.length ? new Promise((resolve) => this.saved.push(resolve)) : Promise.resolve();
  }

  submit(operation: Mutation, remember = true): boolean {
    const before = this.document;
    try {
      this.document = applyMutation(before, operation);
      const id = ++this.next;
      if (operation.kind === "edit")
        for (const edit of operation.edits) {
          const key = `${edit.rowId}/${edit.columnId}`;
          this.invalid.delete(key);
          this.lastEdit.set(key, id);
        }
      let entry: Mutation | undefined;
      if (remember) {
        entry = inverse(before, operation);
        this.undo = [...this.undo, entry].slice(-200);
        this.redo = [];
      }
      this.pending.push({ id, operation, ...(entry ? { entry } : {}) });
      this.error = "";
      this.emit();
      void this.drain();
      return true;
    } catch (error) {
      this.failure = error;
      this.error = error instanceof Error ? error.message : String(error);
      if (operation.kind === "edit" && !operation.strict)
        for (const edit of operation.edits) this.invalid.set(`${edit.rowId}/${edit.columnId}`, { edit, message: this.error });
      this.emit();
      return false;
    }
  }

  /**
   * A newer list another window saved, taken only when nothing of this copy's is waiting to save:
   * a save's own answer brings the newest list anyway. A typed draft in red stays while its
   * monitor is still there.
   */
  observe(receipt: SaveReceipt): boolean {
    if (this.pending.length || receipt.revision === this.revision) return false;
    this.base = clone(receipt.document);
    this.document = clone(receipt.document);
    this.revision = receipt.revision;
    this.epoch++;
    this.prune();
    this.emit();
    return true;
  }

  /**
   * Undo and Redo put back only what this copy did. One that would undo another window's change
   * since is refused, and goes from the list, since it could never apply now.
   */
  history(forward: boolean) {
    const from = forward ? this.redo : this.undo;
    const operation = from.pop();
    if (!operation) return;
    const reverse = inverse(this.document, operation);
    const before = this.next;
    if (this.submit({ ...operation, strict: true }, false)) {
      (forward ? this.undo : this.redo).push(reverse);
      const item = this.pending.find((pending) => pending.id === before + 1);
      if (item) item.entry = reverse;
    } else if (!(this.failure instanceof LeftAlone)) from.push(operation);
  }

  discard(rowId: string, columnId: string) {
    this.invalid.delete(`${rowId}/${columnId}`);
    this.error = "";
    this.emit();
  }

  /** Red drafts for monitors that are gone have nothing to correct. */
  private prune() {
    for (const key of [...this.invalid.keys()]) {
      const rowId = key.slice(0, key.lastIndexOf("/"));
      if (!this.document.monitors.some((row) => row.id === rowId)) this.invalid.delete(key);
    }
  }

  private reject(item: Pending, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.error = message;
    if (item.entry) {
      this.undo = this.undo.filter((entry) => entry !== item.entry);
      this.redo = this.redo.filter((entry) => entry !== item.entry);
    }
    if (item.operation.kind === "edit" && !item.operation.strict)
      for (const edit of item.operation.edits) {
        const key = `${edit.rowId}/${edit.columnId}`;
        if (this.lastEdit.get(key) === item.id) this.invalid.set(key, { edit, message });
      }
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    let refused = false;
    try {
      while (this.pending.length) {
        const item = this.pending[0]!;
        try {
          const reply = await this.save(item.operation);
          this.base = clone(reply.document);
          this.revision = reply.revision;
          this.epoch++;
          if (reply.clashes?.length) for (const listener of [...this.clashListeners]) listener(reply.clashes);
        } catch (error) {
          this.reject(item, error);
          refused = true;
          // A later edit to the same cell was made over the value that was refused, which never
          // reached the list. It goes onto the value as saved, which is not another window's change.
          if (item.operation.kind === "edit") {
            const refusedCells = new Set(item.operation.edits.map((edit) => `${edit.rowId}/${edit.columnId}`));
            for (const later of this.pending.slice(1))
              if (later.operation.kind === "edit")
                for (const edit of later.operation.edits) {
                  // Only the next edit to that cell: any after it were made over that one's value.
                  if (!refusedCells.delete(`${edit.rowId}/${edit.columnId}`)) continue;
                  const row = this.base.monitors.find((monitor) => monitor.id === edit.rowId);
                  if (row) edit.expected = row.values[edit.columnId] ?? "";
                }
          }
        }
        this.pending.shift();
        let projected = clone(this.base);
        const remaining: Pending[] = [];
        for (const later of this.pending) {
          try {
            projected = applyMutation(projected, later.operation);
            remaining.push(later);
          } catch (error) {
            this.reject(later, error);
            refused = true;
          }
        }
        this.pending = remaining;
        this.document = projected;
        this.prune();
        this.emit();
      }
    } finally {
      this.running = false;
      for (const resolve of this.saved.splice(0)) resolve();
      for (const listener of [...this.settledListeners]) listener(refused);
    }
  }
}

/**
 * Keeps one open copy of the page on the list as saved, whichever window saved it last. The
 * worker gives the list's revision with its state and with every status update; `saw` takes it.
 * A copy with nothing of its own waiting to save reads the list again when it sees a revision it
 * doesn't hold, and a copy whose save was refused reads it again at once, so its next change
 * starts from what is saved. A read never replaces a change made while it was on its way.
 */
export function followSaved(store: DraftStore, read: () => Promise<SaveReceipt>) {
  let seen: string | null | undefined;
  /** The revision the last read was asked for, so a late, older revision is read once, not again and again. */
  let askedFor: string | null | undefined;
  let asking = 0;
  let disposed = false;
  const catchUp = (force = false) => {
    if (disposed || store.pending.length) return;
    if (!force && (seen === undefined || seen === store.revision || seen === askedFor)) return;
    askedFor = seen;
    const ask = ++asking;
    const epoch = store.epoch;
    read().then(
      (next) => {
        if (disposed || ask !== asking) return;
        // A save answered meanwhile, or one is waiting: its answer is as new, so ask again only if needed.
        if (epoch !== store.epoch || store.pending.length) {
          askedFor = undefined;
          return;
        }
        store.observe(next);
      },
      () => {
        if (ask === asking) askedFor = undefined;
      },
    );
  };
  const stop = store.onSettled((refused) => catchUp(refused));
  return {
    saw(revision: unknown) {
      if (typeof revision !== "string" && revision !== null) return;
      seen = revision;
      catchUp();
    },
    dispose() {
      disposed = true;
      stop();
    },
  };
}
