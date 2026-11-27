import { mountSwitch, type MountedControl } from "@hubble/module-sdk/controls";
import {
  createSpreadsheetContextMenu,
  MODULE_SPREADSHEET_HISTORY_FEATURE,
  mountSpreadsheetControls,
  type SpreadsheetAddress,
  type SpreadsheetCell,
  type SpreadsheetColumn,
  type SpreadsheetControlsOptions,
  type SpreadsheetEdit,
  type SpreadsheetEditBatch,
  type SpreadsheetHistoryChange,
} from "@hubble/module-sdk/spreadsheet-controls";
import type { RoutingLive, RoutingRow, RoutingSave, RoutingSnapshot } from "./routing.js";
import { applyRoutingChange, noRoutingChange, routingChange, type RoutingChange } from "./changes.js";

/** The routing engine's on-air lamps, as the operator reads them. */
const INDICATORS = [
  { value: "default", label: "Default" },
  { value: "flag1", label: "Tally 1" },
  { value: "flag2", label: "Tally 2" },
  { value: "flag3", label: "Tally 3" },
  { value: "flag4", label: "Tally 4" },
  { value: "left", label: "Left" },
  { value: "text", label: "Text" },
  { value: "right", label: "Right" },
] as const;
type Indicator = (typeof INDICATORS)[number]["value"];
type Numeric = "address" | "destination" | "source" | "level" | "screen";
const NUMBERS: Record<Numeric, { min: number; max: number; label: string }> = {
  address: { min: 0, max: 65534, label: "Address" },
  destination: { min: 1, max: 65536, label: "Output" },
  source: { min: 1, max: 65536, label: "Source" },
  level: { min: 1, max: 256, label: "Level" },
  screen: { min: 0, max: 65534, label: "Screen" },
};
interface Column extends SpreadsheetColumn {
  readonly width: number;
  readonly numeric?: boolean;
}
const COLUMNS: readonly Column[] = [
  { id: "name", label: "Camera", width: 140, fill: "series" },
  { id: "enabled", label: "Enabled", width: 76 },
  { id: "address", label: "Address", width: 80, fill: "series", numeric: true },
  { id: "program", label: "Tally", width: 90 },
  { id: "router", label: "Router", width: 160 },
  { id: "destination", label: "Output", width: 76, numeric: true },
  { id: "source", label: "Source", width: 76, fill: "series", numeric: true },
  { id: "level", label: "Level", width: 64, numeric: true },
  { id: "screen", label: "Screen", width: 70, numeric: true },
  { id: "indicator", label: "On-air lamp", width: 104 },
  { id: "status", label: "Routing status", width: 250 },
];
const READ_ONLY = new Set(["program", "status"]);
const ROW_NUMBER_WIDTH = 44;
/** A camera's value in an editable column, as the grid holds it: what Undo compares and puts back. */
const valueOf = (row: RoutingRow, columnId: string): string => {
  switch (columnId) {
    case "name":
      return row.name;
    case "enabled":
      return row.enabled ? "TRUE" : "FALSE";
    case "router":
      return row.router;
    case "indicator":
      return row.indicator;
    default:
      return columnId in NUMBERS ? String(row[columnId as Numeric]) : "";
  }
};
const EDITABLE = COLUMNS.filter((column) => !READ_ONLY.has(column.id)).map((column) => column.id);

export interface RoutingViewOptions {
  readonly snapshot: RoutingSnapshot;
  readonly live: RoutingLive;
  /** Asks the backend, and again while the module restarts. */
  ask(command: string, value?: unknown): Promise<unknown>;
  failed(message: string): void;
  isDisposed(): boolean;
}

/**
 * The Routing tab: the camera mappings and Follow, merged in from TALLY Switch. Edits show at
 * once and save in order behind; a save the workspace refuses puts back only that edit.
 *
 * The page can be open in several HubDash windows at once. Each copy sends only what it changed,
 * which the backend puts onto what is saved now, and each follows what the others save without a
 * reload. The cell being typed in is never redrawn, moved or taken away while typing goes on.
 *
 * On a Hubble with grid undo (module-spreadsheet-history-v1), Command+Z and Shift+Command+Z undo
 * and redo cell edits and added or deleted cameras, one gesture at a time, in this copy. An Undo
 * is saved like any other change, so every copy shows it, but it puts back only what this copy
 * did: a cell or camera another window has changed since is left as it is, and the page says so.
 */
export async function mountRoutingView(options: RoutingViewOptions) {
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  const grid = el<HTMLTableElement>("routing-grid");
  const viewport = el("routing-view");
  const body = grid.tBodies[0]!;
  /** The cameras as shown: what is saved, with this copy's changes on their way on top. */
  let rows: RoutingRow[] = structuredClone([...options.snapshot.rows]);
  /** The cameras as saved, as far as this copy knows: its own changes are counted from these. */
  let base: RoutingRow[] = structuredClone(rows);
  let revision = options.snapshot.revision;
  /** The newest revision the backend has said it holds, and how many times it has said one. */
  let announced = options.snapshot.revision;
  let announcements = 0;
  let live: RoutingLive = options.live;
  let following = options.snapshot.following;
  let followPending = 0;
  let saving: Promise<void> | undefined;
  /** Counts this copy's own changes, so a read that crossed one is not taken in over it. */
  let edits = 0;
  /** Cameras saved elsewhere are being read in. */
  let rereading = false;
  /**
   * The value this copy last put in each cell. An Undo or Redo puts a cell back, or takes a camera
   * away, only while it still holds that, so it never undoes a change another window made since.
   */
  const mine = new Map<string, string>();
  /** A change Hubble's undo holds: what `history.forget` takes, and `mine` as it was before it. */
  interface Step {
    readonly owner: object;
    readonly before: readonly (readonly [cell: string, value: string | undefined])[];
  }
  /** Steps whose change is shown here but not saved yet, so a refused save can hand them back. */
  let unsaved: Step[] = [];
  /** Cells an Undo or Redo set, and cameras one took away, not sent yet: they go only over what this copy last read. */
  const stepped = new Set<string>();
  const rowElements = new Map<string, HTMLTableRowElement>();
  const cells = new Map<string, HTMLTableCellElement>();
  const key = (address: SpreadsheetAddress) => `${address.rowId}/${address.columnId}`;
  /** Notes what this copy now holds in cells it changed, and returns what it held there before. */
  const own = (edits: readonly SpreadsheetEdit[]) =>
    edits.map((edit) => {
      const before = [key(edit), mine.get(key(edit))] as const;
      mine.set(key(edit), edit.value);
      return before;
    });
  /** Every editable cell of a camera, as this copy now holds it. */
  const cellsOf = (row: RoutingRow): SpreadsheetEdit[] =>
    EDITABLE.map((columnId) => ({ rowId: row.id, columnId, value: valueOf(row, columnId) }));
  /** A cell another window has changed since this copy last did. */
  const changedElsewhere = (row: RoutingRow, columnId: string) => {
    const left = mine.get(key({ rowId: row.id, columnId }));
    return left !== undefined && left !== valueOf(row, columnId);
  };
  const statusOf = (id: string) => live.statuses.find((item) => item.id === id);
  const routerLabel = (id: string) => live.routers.find((router) => router.id === id)?.label;
  let editor: { address: SpreadsheetAddress; input: HTMLInputElement } | undefined;

  // ----- Head: fixed widths, so nothing moves as values change -----
  const colgroup = grid.querySelector("colgroup")!;
  colgroup.replaceChildren(
    ...[ROW_NUMBER_WIDTH, ...COLUMNS.map((column) => column.width)].map((width) => {
      const col = document.createElement("col");
      col.style.width = `${width}px`;
      return col;
    }),
  );
  const headRow = document.createElement("tr");
  const corner = document.createElement("th");
  corner.className = "row-number";
  corner.scope = "col";
  headRow.append(corner);
  for (const column of COLUMNS) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column.label;
    if (column.numeric) th.className = "num";
    headRow.append(th);
  }
  grid.tHead!.replaceChildren(headRow);

  // ----- Cells -----
  const cellOf = (address: SpreadsheetAddress): SpreadsheetCell | null => {
    const row = rows.find((item) => item.id === address.rowId);
    if (!row) return null;
    switch (address.columnId) {
      case "name":
        return { value: valueOf(row, "name") };
      case "enabled":
        return { value: valueOf(row, "enabled"), kind: "boolean" };
      case "program":
        return { value: statusOf(row.id)?.program ?? "Unknown", readOnly: true };
      case "status":
        return { value: statusOf(row.id)?.status ?? "", readOnly: true };
      case "router":
        return {
          value: valueOf(row, "router"),
          choices: live.routers.map((router) => ({ value: router.id, label: router.label })),
        };
      case "indicator":
        return { value: valueOf(row, "indicator"), choices: INDICATORS };
      default:
        return address.columnId in NUMBERS ? { value: valueOf(row, address.columnId) } : null;
    }
  };
  const paint = (address: SpreadsheetAddress) => {
    const cell = cells.get(key(address));
    const row = rows.find((item) => item.id === address.rowId);
    if (!cell || !row || editor?.input.parentElement === cell) return;
    const value = cellOf(address)?.value ?? "";
    let text = value;
    let missing = false;
    if (address.columnId === "enabled") text = row.enabled ? "✓" : "";
    else if (address.columnId === "router") {
      text = row.router ? (routerLabel(row.router) ?? "Router missing") : "Choose a router";
      missing = !row.router || !routerLabel(row.router);
    } else if (address.columnId === "indicator")
      text = INDICATORS.find((item) => item.value === row.indicator)?.label ?? row.indicator;
    if (cell.textContent !== text) cell.textContent = text;
    cell.classList.toggle("missing", missing);
  };
  const draw = () => {
    const order = rows.map((row) => row.id);
    // A camera deleted in another window while its cell is typed in here stays where it is until
    // the typing ends.
    const typedIn = editor && !order.includes(editor.address.rowId) ? rowElements.get(editor.address.rowId) : undefined;
    for (const [id, element] of rowElements)
      if (!order.includes(id) && element !== typedIn) {
        element.remove();
        rowElements.delete(id);
        for (const column of COLUMNS) cells.delete(key({ rowId: id, columnId: column.id }));
      }
    let place = 0;
    order.forEach((id, index) => {
      let element = rowElements.get(id);
      if (!element) {
        element = document.createElement("tr");
        const number = document.createElement("th");
        number.scope = "row";
        number.className = "row-number";
        element.append(number);
        for (const column of COLUMNS) {
          const cell = document.createElement("td");
          cell.dataset.hubbleRow = id;
          cell.dataset.hubbleColumn = column.id;
          cell.setAttribute("role", "gridcell");
          cell.setAttribute("aria-readonly", String(READ_ONLY.has(column.id)));
          if (column.numeric) cell.className = "num";
          if (column.id === "enabled") cell.className = "check";
          if (READ_ONLY.has(column.id)) cell.classList.add("quiet");
          element.append(cell);
          cells.set(key({ rowId: id, columnId: column.id }), cell);
        }
        rowElements.set(id, element);
      }
      // Rows are placed around the one being typed in; it is never moved, which would end the typing.
      if (typedIn && body.children[place] === typedIn) place++;
      if (body.children[place] !== element) body.insertBefore(element, body.children[place] ?? null);
      place++;
      element.cells[0]!.textContent = String(index + 1);
      element.dataset.air = String(statusOf(id)?.program === "ON AIR");
      for (const column of COLUMNS) paint({ rowId: id, columnId: column.id });
    });
    el("routing-empty").hidden = rows.length > 0;
    drawToolbar();
    controls?.refresh();
  };

  // ----- Toolbar: Follow and what it is doing -----
  const drawToolbar = () => {
    const onAir = rows.filter((row) => statusOf(row.id)?.program === "ON AIR" && row.enabled);
    const tone = live.notice ? "warn" : following ? (onAir.length ? "ok" : "idle") : "idle";
    el("follow-state").dataset.tone = tone;
    el("follow-state-text").textContent = !following
      ? "Not following · nothing is routed"
      : live.notice
        ? `Following · ${live.notice}`
        : onAir.length
          ? `Following · ${onAir.map((row) => row.name || "Unnamed").join(", ")} on air`
          : "Following · no camera on air";
    const used = [...new Set(rows.map((row) => routerLabel(row.router)).filter(Boolean))];
    el("routing-count").textContent = `${rows.length} ${rows.length === 1 ? "camera" : "cameras"}${used.length ? ` · ${used.join(", ")}` : ""}`;
    followControl?.refresh();
  };
  const followControl: MountedControl = await mountSwitch({
    root: el("follow"),
    label: "Follow tally",
    ...({ layout: "inline" } as object),
    getState: () => ({ checked: following }),
    onCheckedChange: (checked) => {
      const before = following;
      following = checked;
      followPending += 1;
      drawToolbar();
      void (options.ask("routing-follow", { mode: checked ? "follow" : "unfollow" }) as Promise<{ following: boolean }>)
        .then((reply) => {
          if (followPending === 1) following = reply.following;
        })
        .catch((error: unknown) => {
          if (followPending === 1) following = before;
          options.failed(error instanceof Error ? error.message : "Follow could not be changed");
        })
        .finally(() => {
          followPending -= 1;
          drawToolbar();
        });
    },
  });

  // ----- Saving: in order, only what changed here, onto what is saved now -----
  const named = (from: readonly RoutingRow[], ids: readonly string[]) =>
    ids.length === 1
      ? `${from.find((row) => row.id === ids[0])?.name || "A camera"} was deleted in another window`
      : `${ids.length} cameras were deleted in another window`;
  /** The cameras as saved now, from the backend, without the live tally. */
  const readSaved = async () => ((await options.ask("saved", { routing: true })) as { routing?: RoutingSnapshot }).routing;
  /** This copy now holds what is saved: shown as it is, unless a change of its own is on its way. */
  const takeSaved = (snapshot: RoutingSnapshot) => {
    base = structuredClone([...snapshot.rows]);
    rows = structuredClone(base);
    revision = snapshot.revision;
    draw();
  };
  /** What an Undo or Redo left as it is, in the operator's words: cells, or a camera it would have taken away. */
  const leftAlone = (items: readonly { readonly id: string; readonly field?: string }[], from: readonly RoutingRow[]) => {
    const [first] = items;
    if (items.length > 1 || !first)
      return `${items.length} ${items.some((item) => !item.field) ? "changes" : "cells"} were changed in another window since, so they were left as they are`;
    const camera = from.find((row) => row.id === first.id)?.name || "An unnamed camera";
    if (!first.field) return `${camera} was changed in another window since, so it was left as it is`;
    const column = COLUMNS.find((item) => item.id === first.field)?.label ?? first.field;
    return `${camera}'s ${column} was changed in another window since, so it was left as it is`;
  };
  /** What an Undo or Redo changed or took away in a change, with each field as this copy last read it. */
  const expectedFor = (change: RoutingChange) => {
    const expected: { id: string; fields: Record<string, unknown> }[] = [];
    const held = (id: string, fields: readonly string[]) => {
      const was = base.find((row) => row.id === id);
      const values: Record<string, unknown> = {};
      for (const field of fields) if (was) values[field] = was[field as keyof RoutingRow];
      if (Object.keys(values).length) expected.push({ id, fields: values });
    };
    for (const { id, fields } of change.changed)
      held(id, Object.keys(fields).filter((field) => stepped.delete(key({ rowId: id, columnId: field }))));
    for (const id of change.removed) if (stepped.delete(id)) held(id, EDITABLE);
    return expected;
  };
  const save = (): Promise<void> => {
    saving ??= (async () => {
      try {
        while (!options.isDisposed()) {
          const change = routingChange(base, rows);
          if (noRoutingChange(change)) {
            // What the steps changed is saved, or came back to what is saved.
            unsaved = [];
            break;
          }
          const sent = rows;
          const carried = unsaved;
          unsaved = [];
          const expected = expectedFor(change);
          try {
            const reply = (await options.ask("routing-save", {
              change: expected.length ? { ...change, expected } : change,
            })) as RoutingSave;
            base = reply.rows;
            revision = reply.revision;
            // A change to a camera that another window deleted is not kept, and says so.
            if (reply.missing.length) options.failed(named(sent, reply.missing));
            // Nor is an Undo of what another window changed a moment ago, before this copy heard.
            else if (reply.kept.length) options.failed(leftAlone(reply.kept, sent));
          } catch (error) {
            if (options.isDisposed()) return;
            // Refused: only this change is put back, and the copy takes what is saved now, so its
            // next change is not refused for the same reason. Undo forgets a change that never held,
            // and keeps an undo or redo that didn't take to try again. What this copy holds in
            // those cells is what it held before, unless it has changed them again since.
            const since = new Set(unsaved.flatMap((step) => step.before.map(([cell]) => cell)));
            for (const step of [...carried].reverse()) {
              controls.history?.forget(step.owner);
              for (const [cell, value] of step.before)
                if (since.has(cell)) continue;
                else if (value === undefined) mine.delete(cell);
                else mine.set(cell, value);
            }
            const fresh = await readSaved().catch(() => undefined);
            if (fresh) {
              base = structuredClone([...fresh.rows]);
              revision = fresh.revision;
            }
            options.failed(error instanceof Error ? error.message : "The camera mappings could not be saved");
          }
          if (options.isDisposed()) return;
          // Changes made here while that one was saving go on top of what is saved now.
          rows = applyRoutingChange(base, routingChange(sent, rows)).rows;
          draw();
        }
      } finally {
        saving = undefined;
      }
      follow();
    })();
    return saving;
  };
  /** Shows a change at once and saves it behind. `step` is what Hubble's undo holds for it. */
  const change = (next: RoutingRow[], step?: Step) => {
    rows = next;
    edits += 1;
    if (step) unsaved.push(step);
    draw();
    void save();
  };
  /** Reads in what another window saved. A change of this copy's own, made meanwhile, wins. */
  const follow = () => {
    if (options.isDisposed() || saving || rereading || announced === revision) return;
    rereading = true;
    const at = edits;
    const heard = announcements;
    void readSaved()
      .then((fresh) => {
        // Saving brings back what is saved anyway, this copy's change on top.
        if (!fresh || saving || edits !== at || options.isDisposed()) return;
        takeSaved(fresh);
        // What was read is the newest, unless another revision was announced meanwhile.
        if (announcements === heard) announced = fresh.revision;
        else setTimeout(follow, 50);
      })
      .catch(() => undefined)
      .finally(() => {
        rereading = false;
      });
  };

  // ----- Edits: checked here, shown at once, saved behind -----
  const parse = (row: RoutingRow, edit: SpreadsheetEdit): RoutingRow | string => {
    const raw = edit.value.trim();
    switch (edit.columnId) {
      case "name":
        return raw.length > 160 ? "A camera name is at most 160 characters" : { ...row, name: raw };
      case "enabled": {
        const on = /^(true|1|yes|on|✓)$/iu.test(raw);
        const off = /^(false|0|no|off|)$/iu.test(raw);
        return on || off ? { ...row, enabled: on } : "Enabled is on or off";
      }
      case "router": {
        if (raw === "") return { ...row, router: "" };
        const router = live.routers.find(
          (item) => item.id === raw || item.label.toLocaleLowerCase() === raw.toLocaleLowerCase(),
        );
        return router ? { ...row, router: router.id } : `No router here is called ${raw}`;
      }
      case "indicator": {
        const indicator = INDICATORS.find(
          (item) => item.value === raw || item.label.toLocaleLowerCase() === raw.toLocaleLowerCase(),
        );
        return indicator ? { ...row, indicator: indicator.value as Indicator } : `${raw} isn't an on-air lamp`;
      }
      default: {
        const rule = NUMBERS[edit.columnId as Numeric];
        if (!rule) return "That cell can't be changed";
        const number = /^\d+$/u.test(raw) ? Number(raw) : Number.NaN;
        return Number.isInteger(number) && number >= rule.min && number <= rule.max
          ? { ...row, [edit.columnId]: number }
          : `${rule.label} is a whole number from ${rule.min} to ${rule.max}`;
      }
    }
  };
  /** Applies edits from the grid (`batch`: a gesture, an Undo or a Redo) or from typing in a cell (no batch). */
  const submit = (edits: readonly SpreadsheetEdit[], batch?: SpreadsheetEditBatch) => {
    const stepping = batch?.source === "undo" || batch?.source === "redo";
    let next = rows;
    const problems: string[] = [];
    const applied: SpreadsheetEdit[] = [];
    const kept: { id: string; field: string }[] = [];
    for (const edit of edits) {
      // Clearing leaves numbers as they are: a camera always has an address, output and source.
      if (batch?.source === "clear" && edit.columnId in NUMBERS) continue;
      const index = next.findIndex((row) => row.id === edit.rowId);
      if (index < 0 || READ_ONLY.has(edit.columnId)) continue;
      // An Undo or Redo puts back only what this copy did, never over another window's change since.
      if (stepping && changedElsewhere(next[index]!, edit.columnId)) {
        kept.push({ id: edit.rowId, field: edit.columnId });
        continue;
      }
      const result = parse(next[index]!, edit);
      if (typeof result === "string") problems.push(result);
      else if (JSON.stringify(result) !== JSON.stringify(next[index])) {
        next = [...next];
        next[index] = result;
        applied.push({ rowId: edit.rowId, columnId: edit.columnId, value: valueOf(result, edit.columnId) });
      }
    }
    const history = controls.history;
    let owner: object | undefined = stepping && applied.length ? batch : undefined;
    if (history && !stepping) {
      // Hubble remembered the grid's gesture as it was asked for. The step is what this tab took,
      // as it shows it now: a value refused here, a number Delete left alone or text that changed
      // nothing is no step. Typing joins here too, before it shows.
      if (batch) history.forget(batch);
      if (applied.length) owner = history.record(applied);
    }
    for (const edit of applied)
      if (stepping) stepped.add(key(edit));
      else stepped.delete(key(edit));
    const before = own(applied);
    if (next !== rows) change(next, owner && { owner, before });
    if (kept.length) options.failed(leftAlone(kept, rows));
    else if (problems.length) options.failed(problems[0]!);
  };

  const gridOptions: SpreadsheetControlsOptions = {
    root: grid,
    viewport,
    extendedEditing: true,
    getRows: () => rows.map((row) => row.id),
    getColumns: () => COLUMNS,
    getCell: cellOf,
    onEdit: (batch) => submit(batch.edits, batch),
    onError: (error) => options.failed(error.message),
  };
  // Hubble keeps undo for the grid where it can. An earlier Hubble has none, and the tab works as before.
  const controls = await mountSpreadsheetControls({ ...gridOptions, history: true }).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes(MODULE_SPREADSHEET_HISTORY_FEATURE))
      return mountSpreadsheetControls(gridOptions);
    throw error;
  });

  // ----- Typing in a cell: F2, a character or a double-click. Enter moves on, as in the Matrix. -----
  const startEdit = (cell: HTMLTableCellElement, initial?: string) => {
    const address = { rowId: cell.dataset.hubbleRow ?? "", columnId: cell.dataset.hubbleColumn ?? "" };
    const field = cellOf(address);
    if (!field || field.readOnly || field.choices || field.kind === "boolean") return false;
    const input = document.createElement("input");
    input.className = "cell-input";
    input.setAttribute("aria-label", `Edit ${COLUMNS.find((column) => column.id === address.columnId)?.label ?? "cell"}`);
    input.value = initial ?? field.value;
    const current = { address, input };
    const camera = rows.find((row) => row.id === address.rowId);
    editor = current;
    /** Ends the typing. False when the camera was deleted in another window meanwhile. */
    const finish = (commit: boolean, focusGrid: boolean): boolean => {
      if (editor !== current) return true;
      editor = undefined;
      if (!rows.some((row) => row.id === address.rowId)) {
        // Deleted in another window while it was typed in: it goes now, and what was typed with it.
        draw();
        if (commit && input.value !== field.value && camera) options.failed(named([camera], [camera.id]));
        if (focusGrid) grid.focus({ preventScroll: true });
        return false;
      }
      if (commit && input.value !== field.value) submit([{ ...address, value: input.value }]);
      paint(address);
      if (focusGrid) controls.select(address);
      return true;
    };
    input.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (!finish(event.key !== "Escape", true)) return;
        if (event.key === "Tab") controls.move?.(event.shiftKey ? -1 : 1, 0);
        else if (event.key === "Enter") controls.move?.(0, event.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener("blur", () => finish(true, false), { once: true });
    cell.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  };
  grid.addEventListener(
    "keydown",
    (event) => {
      if (event.target !== grid || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const cell = grid.querySelector<HTMLTableCellElement>('[data-hubble-spreadsheet-active="true"]');
      if (!cell) return;
      if ((event.key === "F2" || event.key.length === 1) && startEdit(cell, event.key.length === 1 ? event.key : undefined)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  grid.addEventListener("dblclick", (event) => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>("td");
    if (cell && grid.contains(cell) && !editor) startEdit(cell);
  });

  // ----- Adding and deleting cameras -----
  const nextName = (name: string, count: number) => {
    const match = /^(.*?)(\d+)$/u.exec(name);
    return match ? `${match[1]}${String(Number(match[2]) + 1).padStart(match[2]!.length, "0")}` : `Camera ${count + 1}`;
  };
  const newId = () =>
    [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  /** A camera after `after` (or at the end): the next number, on the same router, output and level. */
  const add = (after?: string) => {
    const index = after ? rows.findIndex((row) => row.id === after) : rows.length - 1;
    const like = rows[index] ?? rows.at(-1);
    const row: RoutingRow = {
      id: newId(),
      name: like ? nextName(like.name, rows.length) : "Camera 1",
      enabled: true,
      screen: like?.screen ?? 0,
      address: like ? Math.min(like.address + 1, 65534) : 1,
      indicator: like?.indicator ?? "default",
      router: like?.router ?? (live.routers.length === 1 ? live.routers[0]!.id : ""),
      destination: like?.destination ?? 1,
      source: like ? Math.min(like.source + 1, 65536) : 1,
      level: like?.level ?? 1,
    };
    if (rows.length >= 512) {
      options.failed("A routing sheet holds at most 512 cameras");
      return;
    }
    const next = [...rows];
    const at = index < 0 ? next.length : index + 1;
    next.splice(at, 0, row);
    const owner = controls.history?.recordChange(cameraChange([{ row, index: at }], true));
    // Every cell of the new camera holds what this copy put there.
    const before = own(cellsOf(row));
    change(next, owner && { owner, before });
    controls.select({ rowId: row.id, columnId: "name" });
  };
  const remove = (ids: readonly string[]) => {
    const gone = rows.flatMap((row, index) => (ids.includes(row.id) ? [{ row, index }] : []));
    if (!gone.length) return;
    const owner = controls.history?.recordChange(cameraChange(gone, false));
    change(
      rows.filter((row) => !ids.includes(row.id)),
      owner && { owner, before: [] },
    );
  };
  /**
   * Adding or deleting cameras, as one step of Hubble's undo. Cameras come back whole, as they were
   * when they went, in their places; ones another window has already put back or taken away are
   * left. A camera is taken away only as this copy last left it: one another window has changed
   * since stays, and the page says so.
   */
  const cameraChange = (cameras: readonly { row: RoutingRow; index: number }[], added: boolean): SpreadsheetHistoryChange => {
    const ids = cameras.map(({ row }) => row.id);
    const putBack = (attempt: object) => {
      const next = [...rows];
      const back: RoutingRow[] = [];
      for (const { row, index } of [...cameras].sort((a, b) => a.index - b.index))
        if (!next.some((item) => item.id === row.id)) {
          back.push(structuredClone(row));
          next.splice(Math.min(index, next.length), 0, back.at(-1)!);
        }
      if (!back.length) return;
      change(next, { owner: attempt, before: own(back.flatMap(cellsOf)) });
      controls.select({ rowId: cameras[0]!.row.id, columnId: "name" }, undefined, { focus: document.activeElement === grid });
    };
    const takeAway = (attempt: object) => {
      const here = rows.filter((row) => ids.includes(row.id));
      const kept = here.filter((row) => EDITABLE.some((columnId) => changedElsewhere(row, columnId)));
      const going = new Set(here.filter((row) => !kept.includes(row)).map((row) => row.id));
      if (going.size) {
        for (const id of going) stepped.add(id);
        change(rows.filter((row) => !going.has(row.id)), { owner: attempt, before: [] });
      }
      if (kept.length) options.failed(leftAlone(kept.map((row) => ({ id: row.id })), rows));
    };
    return added ? { undo: takeAway, redo: putBack } : { undo: putBack, redo: takeAway };
  };
  el("add-camera").addEventListener("click", () => add());

  const menu = await createSpreadsheetContextMenu({ root: grid, onError: (error) => options.failed(error.message) });
  let selected: string[] = [];
  grid.addEventListener("contextmenu", (event) => {
    const cell = (event.target as Element | null)?.closest<HTMLElement>("[data-hubble-row]");
    const rowId = cell?.dataset.hubbleRow;
    if (!rowId) return;
    event.preventDefault();
    const active = [...grid.querySelectorAll<HTMLElement>('[data-hubble-spreadsheet-selected]')]
      .map((item) => item.dataset.hubbleRow ?? "")
      .filter(Boolean);
    selected = active.includes(rowId) ? [...new Set(active)] : [rowId];
    const name = rows.find((row) => row.id === rowId)?.name || "this camera";
    menu.open({
      x: event.clientX,
      y: event.clientY,
      label: "Camera",
      items: [
        { id: "add", label: "Add camera below", icon: "add", run: () => add(rowId) },
        { separator: true },
        {
          id: "delete",
          label: selected.length > 1 ? `Delete ${selected.length} cameras` : `Delete ${name}`,
          icon: "delete",
          danger: true,
          run: () => remove(selected),
        },
      ],
    });
  });

  draw();
  return {
    /** Live tally and routing status: drawn in place. Cameras saved elsewhere are read in. */
    live(next: RoutingLive) {
      live = next;
      announced = next.revision;
      announcements += 1;
      follow();
      if (!followPending) following = next.following;
      for (const row of rows) {
        const element = rowElements.get(row.id);
        if (element) element.dataset.air = String(statusOf(row.id)?.program === "ON AIR");
        for (const column of ["program", "status", "router"]) paint({ rowId: row.id, columnId: column });
      }
      drawToolbar();
    },
    /** The backend as it stands after a restart: mappings too, unless a change is on its way. */
    take(snapshot: RoutingSnapshot, next: RoutingLive) {
      live = next;
      announced = next.revision;
      announcements += 1;
      if (!followPending) following = next.following;
      if (!saving && noRoutingChange(routingChange(base, rows))) takeSaved(snapshot);
      else draw();
    },
    dispose() {
      followControl.dispose();
      controls.dispose();
      menu.dispose();
    },
  };
}
