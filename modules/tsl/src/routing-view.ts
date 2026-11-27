import { mountSwitch, type MountedControl } from "@hubble/module-sdk/controls";
import {
  createSpreadsheetContextMenu,
  mountSpreadsheetControls,
  type SpreadsheetAddress,
  type SpreadsheetCell,
  type SpreadsheetColumn,
  type SpreadsheetEdit,
} from "@hubble/module-sdk/spreadsheet-controls";
import type { RoutingLive, RoutingRow, RoutingSave, RoutingSnapshot } from "./routing.js";
import { applyRoutingChange, noRoutingChange, routingChange } from "./changes.js";

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
  const rowElements = new Map<string, HTMLTableRowElement>();
  const cells = new Map<string, HTMLTableCellElement>();
  const key = (address: SpreadsheetAddress) => `${address.rowId}/${address.columnId}`;
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
        return { value: row.name };
      case "enabled":
        return { value: row.enabled ? "TRUE" : "FALSE", kind: "boolean" };
      case "program":
        return { value: statusOf(row.id)?.program ?? "Unknown", readOnly: true };
      case "status":
        return { value: statusOf(row.id)?.status ?? "", readOnly: true };
      case "router":
        return {
          value: row.router,
          choices: live.routers.map((router) => ({ value: router.id, label: router.label })),
        };
      case "indicator":
        return { value: row.indicator, choices: INDICATORS };
      default:
        return address.columnId in NUMBERS ? { value: String(row[address.columnId as Numeric]) } : null;
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
  const save = (): Promise<void> => {
    saving ??= (async () => {
      try {
        while (!options.isDisposed()) {
          const change = routingChange(base, rows);
          if (noRoutingChange(change)) break;
          const sent = rows;
          try {
            const reply = (await options.ask("routing-save", { change })) as RoutingSave;
            base = reply.rows;
            revision = reply.revision;
            // A change to a camera that another window deleted is not kept, and says so.
            if (reply.missing.length) options.failed(named(sent, reply.missing));
          } catch (error) {
            if (options.isDisposed()) return;
            // Refused: only this change is put back, and the copy takes what is saved now, so its
            // next change is not refused for the same reason.
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
  const change = (next: RoutingRow[]) => {
    rows = next;
    edits += 1;
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
  const submit = (edits: readonly SpreadsheetEdit[], source?: string) => {
    let next = rows;
    const problems: string[] = [];
    for (const edit of edits) {
      // Clearing leaves numbers as they are: a camera always has an address, output and source.
      if (source === "clear" && edit.columnId in NUMBERS) continue;
      const index = next.findIndex((row) => row.id === edit.rowId);
      if (index < 0 || READ_ONLY.has(edit.columnId)) continue;
      const result = parse(next[index]!, edit);
      if (typeof result === "string") problems.push(result);
      else if (JSON.stringify(result) !== JSON.stringify(next[index])) {
        next = [...next];
        next[index] = result;
      }
    }
    if (next !== rows) change(next);
    if (problems.length) options.failed(problems[0]!);
  };

  const controls = await mountSpreadsheetControls({
    root: grid,
    viewport,
    extendedEditing: true,
    getRows: () => rows.map((row) => row.id),
    getColumns: () => COLUMNS,
    getCell: cellOf,
    onEdit: ({ source, edits }) => submit(edits, source),
    onError: (error) => options.failed(error.message),
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
    next.splice(index < 0 ? next.length : index + 1, 0, row);
    change(next);
    controls.select({ rowId: row.id, columnId: "name" });
  };
  const remove = (ids: readonly string[]) => change(rows.filter((row) => !ids.includes(row.id)));
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
