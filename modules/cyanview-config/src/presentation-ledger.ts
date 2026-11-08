// Presentation edits share the plan's ordered save queue. A rejected layout and
// its dependent layouts roll back without replacing camera or network drafts.
export type PresentationTicket = Record<string, number>;
interface Change<T> { epoch: number; beforeEpoch: number; before: T; after: T }
export class PresentationLedger<T> {
  private next = 0;
  private epochs = new Map<string, number>();
  private pending = new Map<string, Change<T>[]>();
  private rejected = new Map<string, { epoch: number; value: T }>();
  change(key: string, before: T, after: T) {
    const epoch = ++this.next;
    const changes = this.pending.get(key) ?? [];
    changes.push({ epoch, beforeEpoch: this.epochs.get(key) ?? 0, before: structuredClone(before), after: structuredClone(after) });
    this.pending.set(key, changes); this.epochs.set(key, epoch);
    return epoch;
  }
  ticket(): PresentationTicket { return Object.fromEntries(this.epochs); }
  repairs(ticket: PresentationTicket) {
    return Object.entries(ticket).flatMap(([key, epoch]) => {
      const rejected = this.rejected.get(key + ':' + epoch);
      return rejected ? [{ key, value: structuredClone(rejected.value) }] : [];
    });
  }
  saved(ticket: PresentationTicket) {
    for (const [key, original] of Object.entries(ticket)) {
      const epoch = this.rejected.get(key + ':' + original)?.epoch ?? original;
      this.pending.set(key, (this.pending.get(key) ?? []).filter(change => change.epoch > epoch));
    }
  }
  failed(ticket: PresentationTicket) {
    const rollbacks: { key: string; value: T; epochs: number[] }[] = [];
    for (const [key, epoch] of Object.entries(ticket)) {
      if (this.rejected.has(key + ':' + epoch)) continue;
      const changes = this.pending.get(key) ?? [], first = changes[0];
      if (!first || first.epoch > epoch) continue;
      for (const change of changes) this.rejected.set(key + ':' + change.epoch, { epoch: first.beforeEpoch, value: structuredClone(first.before) });
      this.epochs.set(key, first.beforeEpoch); this.pending.delete(key);
      rollbacks.push({ key, value: structuredClone(first.before), epochs: changes.map(change => change.epoch) });
    }
    return rollbacks;
  }
}
