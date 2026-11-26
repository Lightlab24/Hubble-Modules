/**
 * Puts one open copy's change onto the device list as it is saved now.
 *
 * Each copy of the page (one per HubDash window) builds a change from what it last read: `base`
 * is that, `mine` is what it wants. Another window may have saved since, so the change goes onto
 * `theirs`, the list as saved now. Only what this copy changed is changed; everything else keeps
 * what the other windows saved. A copy is never refused just for having read an older list.
 *
 * When both changed the same value, this copy's wins and the clash is noted, so the page can say
 * so. An Undo or Redo is `strict`: it puts back only what this copy did, and is refused when
 * another window has changed that value since, so it never undoes someone else's work.
 */
export interface Merge {
  readonly strict: boolean;
  /** What this copy changed that another window had also changed, in words for the operator. */
  readonly clashes: string[];
}
/** For layout: the newest change wins, and there is nothing to tell anyone. */
export const quietly = (): Merge => ({ strict: false, clashes: [] });

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sorted(item)]))
      : value;
export const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** An Undo or Redo that would have put back over another window's change. It can never apply now. */
export class LeftAlone extends Error {}
export function leftAlone(what: string) {
  return new LeftAlone(`${what} was changed in another window since, so it was left as it is.`);
}

/** One value: this copy's if it changed it, otherwise whatever is saved now. */
export function mergeValue<T>(what: string, base: T, mine: T, theirs: T, merge: Merge): T {
  if (same(mine, base)) return theirs;
  if (!same(theirs, base) && !same(theirs, mine)) {
    if (merge.strict) throw leftAlone(what);
    merge.clashes.push(what);
  }
  return mine;
}

/** Every key this copy changed, added or took out, over what is saved now. */
export function mergeRecord<T>(what: (key: string) => string, base: Record<string, T>, mine: Record<string, T>, theirs: Record<string, T>, merge: Merge): Record<string, T> {
  const out: Record<string, T> = { ...theirs };
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const value = mergeValue(what(key), base[key], mine[key], theirs[key], merge);
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** The ids `from` and `to` both have in the same order: the longest such run. The others were moved. */
function inOrder(from: readonly string[], to: readonly string[]): Set<string> {
  const lengths = Array.from({ length: from.length + 1 }, () => new Array<number>(to.length + 1).fill(0));
  for (let i = from.length - 1; i >= 0; i--)
    for (let j = to.length - 1; j >= 0; j--)
      lengths[i]![j] = from[i] === to[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const kept = new Set<string>();
  for (let i = 0, j = 0; i < from.length && j < to.length; )
    if (from[i] === to[j]) {
      kept.add(from[i]!);
      i++;
      j++;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  return kept;
}

/**
 * An order of ids, with what this copy added, moved and took out put onto the order saved now.
 * What another window added stays, and what it took out stays out, even if this copy moved it.
 * A row this copy placed goes just before the row it was placed before, or at the end if it was
 * placed last, after anything another window added meanwhile.
 */
export function mergeOrder(base: readonly string[], mine: readonly string[], theirs: readonly string[], moved?: readonly string[]): string[] {
  const inBase = new Set(base);
  const inMine = new Set(mine);
  const inTheirs = new Set(theirs);
  const from = base.filter((id) => inMine.has(id));
  const to = mine.filter((id) => inBase.has(id));
  // Swapping two neighbours could be either one moving. The page says which it moved, when it knows.
  const hint = new Set(moved ?? []);
  const rest = (list: string[]) => list.filter((id) => !hint.has(id));
  const kept = hint.size && same(rest(from), rest(to)) ? new Set(rest(from)) : inOrder(from, to);
  const placing = new Set(mine.filter((id) => (inBase.has(id) ? !kept.has(id) && inTheirs.has(id) : !inTheirs.has(id))));
  const result = theirs.filter((id) => !placing.has(id) && (inMine.has(id) || !inBase.has(id)));
  for (let index = mine.length - 1; index >= 0; index--) {
    const id = mine[index]!;
    if (!placing.has(id)) continue;
    const after = mine.slice(index + 1).find((other) => result.includes(other));
    result.splice(after === undefined ? result.length : result.indexOf(after), 0, id);
  }
  return result;
}

/** A list member as a set: what this copy added goes in, what it took out comes out. */
export function mergeSet(base: readonly string[], mine: readonly string[], theirs: readonly string[]): string[] {
  const added = mine.filter((id) => !base.includes(id) && !theirs.includes(id));
  const removed = new Set(base.filter((id) => !mine.includes(id)));
  return [...theirs.filter((id) => !removed.has(id)), ...added];
}
