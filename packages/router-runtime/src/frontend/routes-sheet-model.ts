import type { RouteCrosspointsResult } from "../page-contract.js";
import type { RouterDraftMapping } from "./router-state.js";

/** What the sheet shows for a cell whose route has been requested but not observed. */
export type RouteCellPhase = "staged" | "queued" | "sending" | "confirming";

export interface RouteCellOverlay {
  readonly source: number;
  readonly phase: RouteCellPhase;
}

export interface RoutesSheetColumn {
  readonly id: string;
  readonly label: string;
  /** Every level a pick in this column routes. */
  readonly levels: readonly number[];
}

export type RoutesSheetCell =
  | { readonly kind: "unknown"; readonly phase: null }
  | { readonly kind: "mixed"; readonly phase: RouteCellPhase | null }
  | {
      readonly kind: "source";
      readonly source: number;
      readonly phase: RouteCellPhase | null;
    };

export interface RoutePick {
  readonly destination: number;
  readonly levels: readonly number[];
  readonly source: number;
}

export interface RouteSendOutcome {
  readonly succeededLevels: readonly number[];
  readonly failedLevels: readonly number[];
  readonly message: string | null;
}

export const ALL_LEVELS_COLUMN_ID = "all";

export function routeCellKey(destination: number, level: number): string {
  return `${String(destination)}:${String(level)}`;
}

/**
 * One column per level. A router with more than one level also gets an All
 * column, where a pick routes every level of that destination.
 */
export function routesSheetColumns(
  levelCount: number,
  showsLevels: boolean,
): readonly RoutesSheetColumn[] {
  const count = Math.max(1, Math.floor(levelCount));
  const levels = Array.from({ length: count }, (_, index) => index + 1);
  const perLevel = levels.map((level) => ({
    id: `level:${String(level)}`,
    label: showsLevels ? `L${String(level)}` : "Source",
    levels: [level],
  }));
  return count > 1
    ? [{ id: ALL_LEVELS_COLUMN_ID, label: "All", levels }, ...perLevel]
    : perLevel;
}

export function routesSheetCell(
  column: RoutesSheetColumn,
  truth: (level: number) => number | null | undefined,
  overlay: (level: number) => RouteCellOverlay | undefined,
): RoutesSheetCell {
  let shared: number | null = null;
  let mixed = false;
  let phase: RouteCellPhase | null = null;
  for (const level of column.levels) {
    if ((truth(level) ?? null) === null)
      return { kind: "unknown", phase: null };
    const pending = overlay(level);
    const source = pending?.source ?? (truth(level) as number);
    phase ??= pending?.phase ?? null;
    if (shared === null) shared = source;
    else if (shared !== source) mixed = true;
  }
  return mixed || shared === null
    ? { kind: "mixed", phase }
    : { kind: "source", source: shared, phase };
}

/** Routes held for Take, or running through it, keyed by destination and level. */
export function draftRouteOverlays(
  drafts: readonly RouterDraftMapping[],
): ReadonlyMap<string, RouteCellOverlay> {
  const overlays = new Map<string, RouteCellOverlay>();
  for (const draft of drafts) {
    const phase: RouteCellPhase | null =
      draft.status === "staged"
        ? "staged"
        : draft.status === "submitting" || draft.status === "pending"
          ? "sending"
          : null;
    if (phase === null) continue;
    for (const level of draft.levels)
      overlays.set(routeCellKey(draft.destination, level), {
        source: draft.source,
        phase,
      });
  }
  return overlays;
}

export interface RouteEditBatch {
  readonly source: string;
  readonly edits: readonly {
    readonly rowId: string;
    readonly columnId: string;
    readonly value: string;
  }[];
}

/**
 * Only a single pick from a cell's source list is a route. Paste and fill can
 * span hundreds of live crosspoints, so they never send anything.
 */
export function routePickFromEdit(
  batch: RouteEditBatch,
  columns: readonly RoutesSheetColumn[],
): RoutePick | null {
  if (batch.source !== "choice" || batch.edits.length !== 1) return null;
  const edit = batch.edits[0];
  if (edit === undefined) return null;
  const column = columns.find(({ id }) => id === edit.columnId);
  const destination = Number(edit.rowId);
  const source = Number(edit.value);
  if (
    column === undefined ||
    !Number.isInteger(destination) ||
    !Number.isInteger(source) ||
    destination < 1 ||
    source < 1
  )
    return null;
  return { destination, source, levels: column.levels };
}

export function sourceChoices(
  sources: readonly {
    readonly address: number;
    readonly label: string | null;
  }[],
): readonly { readonly value: string; readonly label: string }[] {
  return sources.map(({ address, label }) => ({
    value: String(address),
    label: `${String(address)} — ${label || "Unlabeled"}`,
  }));
}

const OUTCOME_REASONS: Readonly<Record<string, string>> = {
  conflict: "the route changed before it could be sent",
  nak: "the router refused it",
  timeout: "the router didn't answer in time",
  not_attempted: "it wasn't sent",
};

export function routeSendOutcome(
  pick: RoutePick,
  result: RouteCrosspointsResult | null,
): RouteSendOutcome {
  const failed = (message: string): RouteSendOutcome => ({
    succeededLevels: [],
    failedLevels: pick.levels,
    message,
  });
  const name = `Destination ${String(pick.destination)} wasn't routed`;
  if (result === null) return failed(`${name}: the router page changed.`);
  if (result.status === "rejected")
    return failed(`${name}: ${result.message}.`);
  const succeededLevels: number[] = [];
  const failedLevels: number[] = [];
  let reason: string | null = null;
  for (const { level, outcome } of result.outcomes) {
    if (outcome === "acknowledged" || outcome === "already_confirmed") {
      succeededLevels.push(level);
    } else {
      failedLevels.push(level);
      reason ??= OUTCOME_REASONS[outcome] ?? "the route failed";
    }
  }
  return {
    succeededLevels,
    failedLevels,
    message:
      failedLevels.length === 0
        ? null
        : `${name} on level ${failedLevels.join(", ")}: ${reason ?? "the route failed"}.`,
  };
}
