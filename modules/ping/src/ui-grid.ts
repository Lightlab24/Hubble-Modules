import {
  createSpreadsheetContextMenu,
  mountSpreadsheetControls,
  mountSpreadsheetReorder,
  mountSpreadsheetResize,
  mountSpreadsheetViewport,
  type SpreadsheetAddress,
  type SpreadsheetCell,
  type SpreadsheetControls,
  type SpreadsheetEdit,
} from "@hubble/module-sdk/spreadsheet-controls";
import { cellEdits, hideColumnChange, resizeChange } from "./changes.js";
import type { DraftStore } from "./draft-store.js";
import {
  columnOf,
  columns,
  formatMs,
  moveRows,
  rulesOf,
  ruleText,
  spanOf,
  valueOf,
  type CellEdit,
  type Column,
  type DeviceRow,
  type View,
} from "./model.js";
import { drawStrip } from "./timeline.js";
import type { DeviceSummary } from "./watch.js";

export interface GridOptions {
  readonly table: HTMLTableElement;
  readonly viewport: HTMLElement;
  readonly store: DraftStore;
  live(): Record<string, DeviceSummary>;
  /** The devices on show: the open sheet's, in list order. */
  rows(): DeviceRow[];
  /** The Show last this window shows, which the strip column is named after. */
  span(): string;
  onInsert(beforeId: string | null): void;
  /** Removes these devices as one step. */
  onRemove(rowIds: readonly string[]): void;
  onSelect(rowId: string): void;
  onError(message: string): void;
}

const GUTTER = 34;
const ROW_HEIGHT = 36;
const key = (address: SpreadsheetAddress) => `${address.rowId}/${address.columnId}`;
const STATE_LABELS = { "not-checked": "Not checked", online: "Online", slow: "Slow", offline: "Offline" } as const;
const STATE_TONES = { "not-checked": "", online: "ok", slow: "warn", offline: "bad" } as const;

/** The columns on show, in the saved order. Device is always first and always shown. */
export function visibleColumns(view: View): Column[] {
  const hidden = new Set(view.hidden);
  const ordered = view.order.map((id) => columnOf(id)!).filter((column) => column.id !== "name" && !hidden.has(column.id));
  return [columnOf("name")!, ...ordered];
}

/**
 * The device list, drawn by the page and edited through Hubble's shared
 * spreadsheet controls: selection, fill, clipboard, choice editor, checkboxes,
 * menus, resize, row moves and zoom are the same as in the Button Matrix.
 * Ping results are written into their own cells without touching the others.
 */
export async function createDeviceGrid(options: GridOptions) {
  const { table, viewport, store } = options;
  const tracks = table.querySelector("colgroup")!;
  const head = table.createTHead();
  const headerRow = head.insertRow();
  const body = table.createTBody();
  const rows = new Map<string, HTMLTableRowElement>();
  const cells = new Map<string, HTMLTableCellElement>();
  const headers = new Map<string, HTMLTableCellElement>();
  const columnTracks = new Map<string, HTMLTableColElement>();
  const disposables: { dispose(): void }[] = [];
  let shown: Column[] = [];
  let shownKey = "";
  /** The devices drawn, in order. The shared controls are told only of these, so they always match the cells on screen. */
  let drawn: string[] = [];
  /** A save arrived while a cell was being typed in, so the rows and columns wait until it is finished. */
  let deferred: ReturnType<typeof setTimeout> | undefined;
  let active: SpreadsheetAddress | undefined;
  let editor: { address: SpreadsheetAddress; cell: HTMLTableCellElement } | undefined;
  let disposed = false;
  let zoom = 1;
  /** Whole rows picked by their row numbers: click one, Shift-click to a range, Command-click to add or drop one. */
  let pickedRows: string[] = [];
  let pickAnchor: string | undefined;
  let commandHeld = false;
  let rightPress = false;

  const view = () => store.document.view;
  const widthOf = (columnId: string) => view().widths[columnId] ?? columnOf(columnId)!.width;
  const rowOf = (id: string) => store.document.devices.find((row) => row.id === id);
  /** The devices on screen that are still on the list. */
  const drawnRows = () => drawn.map(rowOf).filter((row): row is DeviceRow => !!row && rows.has(row.id));
  const headingOf = (column: Column) => (column.id === "strip" ? spanOf(options.span()).heading : column.label);
  const pinged = (row: DeviceRow) => valueOf(row, "enabled") === "TRUE" && store.document.settings.pinging;

  function liveText(row: DeviceRow, columnId: string): string {
    const summary = options.live()[row.id];
    const state = pinged(row) && valueOf(row, "host") ? (summary?.state ?? "not-checked") : "not-checked";
    if (columnId === "status") return !valueOf(row, "host") && valueOf(row, "enabled") === "TRUE" ? "No IP address" : STATE_LABELS[state];
    if (!summary || state === "not-checked") return "—";
    const value = { now: summary.now, average: summary.average, best: summary.best, worst: summary.worst, jitter: summary.jitter }[columnId];
    if (columnId === "lostPct") return summary.lostPct === null ? "—" : `${summary.lostPct.toFixed(1)}%`;
    return value === null || value === undefined ? "—" : formatMs(value);
  }

  function cellValue(address: SpreadsheetAddress): SpreadsheetCell | null {
    const row = rowOf(address.rowId);
    const column = columnOf(address.columnId);
    if (!row || !column) return null;
    if (column.live) return { value: column.id === "strip" ? "" : liveText(row, column.id), readOnly: true };
    if (column.id === "enabled") return { value: valueOf(row, "enabled"), kind: "boolean" };
    return { value: valueOf(row, column.id) };
  }

  function submit(edits: readonly SpreadsheetEdit[], expected?: string): boolean {
    // Another window can take a device off while its cell is being typed in here.
    if (edits.some((edit) => !rowOf(edit.rowId))) options.onError("That device is no longer on the list, so what you typed wasn't kept.");
    const changes: CellEdit[] = cellEdits(store.document, edits, expected);
    // Putting back the saved value is no change to save, but it does settle a red draft in that cell.
    for (const change of changes)
      if (change.value === change.expected && store.invalid.has(key(change))) store.discard(change.rowId, change.columnId);
    const real = changes.filter((change) => change.value !== change.expected);
    return real.length ? store.submit({ kind: "edit", edits: real }) : true;
  }

  const corner = document.createElement("th");
  corner.className = "row-number corner";
  corner.setAttribute("aria-label", "Device rows");
  const gutterTrack = document.createElement("col");
  gutterTrack.style.width = `${GUTTER}px`;

  /** Rebuilds the header and every row's cells when the columns on show change. */
  function buildColumns() {
    shown = visibleColumns(view());
    shownKey = shown.map((column) => column.id).join(",");
    headers.clear();
    columnTracks.clear();
    cells.clear();
    rows.clear();
    editor = undefined;
    headerRow.replaceChildren(corner);
    tracks.replaceChildren(gutterTrack);
    body.replaceChildren();
    for (const column of shown) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.columnId = column.id;
      th.tabIndex = 0;
      th.className = [column.id === "name" ? "frozen" : "", column.numeric ? "num" : ""].join(" ").trim();
      headers.set(column.id, th);
      headerRow.append(th);
      const track = document.createElement("col");
      columnTracks.set(column.id, track);
      tracks.append(track);
    }
    for (const row of options.rows()) {
      ensureRow(row);
      body.append(rows.get(row.id)!);
    }
    drawn = options.rows().map((row) => row.id);
  }

  function ensureRow(row: DeviceRow) {
    if (rows.has(row.id)) return;
    const tr = document.createElement("tr");
    tr.dataset.rowId = row.id;
    const number = document.createElement("th");
    number.scope = "row";
    number.className = "row-number";
    number.dataset.rowId = row.id;
    tr.append(number);
    for (const column of shown) {
      const cell = tr.insertCell();
      cell.setAttribute("role", "gridcell");
      cell.dataset.rowId = row.id;
      cell.dataset.columnId = column.id;
      cell.dataset.hubbleRow = row.id;
      cell.dataset.hubbleColumn = column.id;
      cell.className = [column.id === "name" ? "frozen" : "", column.numeric ? "num" : "", column.id === "strip" ? "strip" : ""].join(" ").trim();
      if (column.id === "strip") cell.append(document.createElement("canvas"));
      cells.set(`${row.id}/${column.id}`, cell);
    }
    rows.set(row.id, tr);
  }

  // Draw the saved rows before mounting, so every control finds its cells.
  buildColumns();
  const controls: SpreadsheetControls = await mountSpreadsheetControls({
    root: table,
    viewport,
    extendedEditing: true,
    workbookEditing: true,
    getRows: () => drawn,
    getColumns: () => shown.map((column) => ({ id: column.id, label: headingOf(column), fill: column.fill })),
    getCell: cellValue,
    onEdit: (batch) => {
      submit(batch.edits);
    },
    onSelection(address) {
      active = address;
      if (address) options.onSelect(address.rowId);
    },
    onHistory(direction) {
      if (active && store.invalid.has(key(active))) {
        store.discard(active.rowId, active.columnId);
        return;
      }
      store.history(direction === "redo");
    },
    onError: (error) => options.onError(error.message),
  });
  disposables.push(controls);

  const menu = await createSpreadsheetContextMenu({ root: table, onError: (error) => options.onError(error.message) });
  disposables.push(menu);
  table.addEventListener("contextmenu", (event) => {
    const target = (event.target as Element).closest<HTMLTableCellElement>("td,th");
    if (!target) return;
    const rowId = target.dataset.rowId;
    const columnId = target.dataset.columnId;
    if (!rowId) {
      // A column header: hide it, unless it is the device's name.
      if (!columnId || columnId === "name") return;
      event.preventDefault();
      menu.open({
        x: event.clientX,
        y: event.clientY,
        label: headingOf(columnOf(columnId)!),
        items: [{ id: "hide", label: "Hide column", run: () => store.submit(hideColumnChange(store.document, columnId)) }],
      });
      return;
    }
    event.preventDefault();
    const index = drawn.indexOf(rowId);
    // Remove acts on everything selected when the click is inside the selection, and on this row alone when it isn't.
    const selected = selectedRowIds();
    const targets = selected.includes(rowId) ? selected : [rowId];
    const column = columnId ? columnOf(columnId) : undefined;
    menu.open({
      x: event.clientX,
      y: event.clientY,
      label: targets.length > 1 ? `${targets.length} devices` : valueOf(rowOf(rowId)!, "name") || "Device",
      items: [
        ...(column && !column.live && column.id !== "enabled" ? [{ id: "edit", label: "Edit cell", run: () => startEdit(target) }] : []),
        ...(columnId && store.invalid.has(`${rowId}/${columnId}`)
          ? [{ id: "discard", label: "Discard invalid draft", run: () => store.discard(rowId, columnId) }]
          : []),
        { id: "above", label: "Add device above", icon: "add", run: () => options.onInsert(rowId) },
        { id: "below", label: "Add device below", icon: "add", run: () => options.onInsert(drawn[index + 1] ?? null) },
        { separator: true },
        {
          id: "remove",
          label: targets.length > 1 ? `Remove ${targets.length} devices` : "Remove device",
          icon: "delete",
          danger: true,
          run: () => {
            pickedRows = [];
            options.onRemove(targets);
          },
        },
      ],
    });
  });

  const resize = await mountSpreadsheetResize({
    root: table,
    viewport,
    getScale: () => zoom,
    getItems: () => [
      ...shown.filter((column) => headers.has(column.id)).map((column) => ({
        id: column.id,
        label: headingOf(column),
        axis: "column" as const,
        header: headers.get(column.id)!,
        size: widthOf(column.id),
        min: 50,
        max: 1200,
      })),
      // Only rows already drawn: the controls ask while mounting, before the first render.
      ...drawnRows().map((row) => ({
        id: row.id,
        label: valueOf(row, "name"),
        axis: "row" as const,
        header: rows.get(row.id)!.cells[0] as HTMLElement,
        size: view().rowHeights[row.id] ?? ROW_HEIGHT,
        min: 28,
        max: 200,
      })),
    ],
    onResize: (item, size) => store.submit(resizeChange(store.document, item.axis, item.id, size)),
  });
  disposables.push(resize);

  const reorder = await mountSpreadsheetReorder({
    root: table,
    getItems: () =>
      drawnRows().map((row) => ({
        id: row.id,
        label: valueOf(row, "name"),
        axis: "row" as const,
        handle: rows.get(row.id)!.cells[0] as HTMLElement,
        elements: [...rows.get(row.id)!.cells] as HTMLElement[],
      })),
    getSelectedRows: () => pickedRows,
    onSelect(item, extend) {
      // A right-click opens the menu for what is already picked; it never changes the pick.
      if (rightPress) return;
      // The shared control reports a plain or Shift click; Command is read from the press that caused it.
      pickRow(item.id, extend ? "range" : commandHeld ? "toggle" : "one");
    },
    onMove(move) {
      const operation = moveRows(store.document, move.ids, move.beforeId);
      if (operation) store.submit(operation);
    },
    onError: (error) => options.onError(error.message),
  });
  disposables.push(reorder);

  const zoomControls = await mountSpreadsheetViewport({
    root: table,
    viewport,
    onZoom(ratio) {
      zoom = ratio;
      controls.refresh();
      resize.refresh();
      reorder.refresh();
    },
  });
  disposables.push(zoomControls);

  /** Rows the operator has selected: whole rows picked by number, or else every row with a selected cell. */
  function selectedRowIds(): string[] {
    const order = drawn;
    if (pickedRows.length) return order.filter((id) => pickedRows.includes(id));
    const withCells = new Set<string>();
    for (const cell of table.querySelectorAll<HTMLElement>('td[data-hubble-spreadsheet-selected="true"], td[data-hubble-spreadsheet-active="true"]'))
      if (cell.dataset.rowId) withCells.add(cell.dataset.rowId);
    return order.filter((id) => withCells.has(id));
  }
  function pickRow(id: string, how: "one" | "range" | "toggle") {
    const order = drawn;
    if (how === "range" && pickAnchor && order.includes(pickAnchor)) {
      const [from, to] = [order.indexOf(pickAnchor), order.indexOf(id)].sort((a, b) => a - b);
      pickedRows = order.slice(from, to! + 1);
    } else if (how === "toggle") {
      pickedRows = pickedRows.includes(id) ? pickedRows.filter((item) => item !== id) : [...pickedRows, id];
      pickAnchor = id;
    } else {
      pickedRows = [id];
      pickAnchor = id;
    }
    markPicked();
    options.onSelect(id);
  }
  function markPicked() {
    for (const [id, tr] of rows) {
      if (pickedRows.includes(id)) tr.dataset.picked = "true";
      else delete tr.dataset.picked;
    }
  }
  // Command-click on a row number adds or drops that row. Pressing on a cell goes back to cell selection.
  // Listened for on the window, so the keys held are known before the shared control reports the click.
  const pressed = (event: PointerEvent) => {
    commandHeld = event.metaKey || event.ctrlKey;
    rightPress = event.button === 2 || (event.button === 0 && event.ctrlKey && !event.metaKey && navigator.platform.startsWith("Mac"));
    if (event.button !== 0 || !pickedRows.length) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("#device-grid td") : null;
    if (target && table.contains(target)) {
      pickedRows = [];
      markPicked();
    }
  };
  window.addEventListener("pointerdown", pressed, true);
  disposables.push({ dispose: () => window.removeEventListener("pointerdown", pressed, true) });

  /** The page's own text editor for Device, IP Address and the two alert cells. */
  function startEdit(cell: HTMLTableCellElement, initial?: string): boolean {
    const rowId = cell.dataset.rowId;
    const columnId = cell.dataset.columnId;
    if (!rowId || !columnId) return false;
    const address = { rowId, columnId };
    const current = cellValue(address);
    const row = rowOf(rowId);
    if (!current || !row || current.readOnly || current.choices || current.kind) return false;
    const input = document.createElement("input");
    input.className = "cell-input";
    input.setAttribute("aria-label", `Edit ${columnOf(columnId)?.label ?? columnId}`);
    input.spellcheck = false;
    input.value = initial ?? store.invalid.get(key(address))?.edit.value ?? current.value;
    const expected = valueOf(row, columnId);
    const retrying = store.invalid.has(key(address));
    editor = { address, cell };
    const finish = (commit: boolean, focus: boolean) => {
      if (editor?.cell !== cell) return;
      editor = undefined;
      if (commit && (retrying || input.value !== current.value)) submit([{ ...address, value: input.value }], expected);
      render();
      if (focus) controls.select(address);
    };
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || !["Escape", "Tab", "Enter"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      finish(event.key !== "Escape", true);
      if (event.key === "Tab") controls.move?.(event.shiftKey ? -1 : 1, 0);
      else if (event.key === "Enter") controls.move?.(0, 1);
    });
    input.addEventListener("blur", () => finish(true, false), { once: true });
    delete cell.dataset.empty;
    cell.replaceChildren(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }
  table.addEventListener(
    "keydown",
    (event) => {
      if (event.target !== table || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const cell = table.querySelector<HTMLTableCellElement>('[data-hubble-spreadsheet-active="true"]');
      if (cell && (event.key === "F2" || event.key === "Enter" || event.key.length === 1) && startEdit(cell, event.key.length === 1 ? event.key : undefined)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );
  table.addEventListener("dblclick", (event) => {
    const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableCellElement>("td");
    if (cell && table.contains(cell) && !editor) startEdit(cell);
  });

  /** Writes ping results into their cells. It never touches an editable cell, so typing is never interrupted. */
  function renderLive() {
    if (disposed) return;
    const live = options.live();
    for (const row of drawnRows()) {
      const on = pinged(row) && valueOf(row, "host") !== "";
      const summary = live[row.id];
      const limit = rulesOf(row, store.document.settings).overMs;
      for (const column of shown) {
        if (!column.live) continue;
        const cell = cells.get(`${row.id}/${column.id}`);
        if (!cell) continue;
        if (column.id === "strip") {
          drawStrip(cell.firstElementChild as HTMLCanvasElement, on ? summary?.strip : undefined, limit, store.document.view.bands);
          continue;
        }
        const text = liveText(row, column.id);
        if (cell.textContent !== text) cell.textContent = text;
        if (column.id === "status") {
          const tone = on ? STATE_TONES[summary?.state ?? "not-checked"] : "";
          if (tone) cell.dataset.tone = tone;
          else delete cell.dataset.tone;
        }
      }
    }
  }

  /** One editable cell's value, as saved or as a typed draft in red. Never the cell being typed in. */
  function paint(row: DeviceRow, column: Column, cell: HTMLTableCellElement) {
    if (column.live || cell === editor?.cell) return;
    const address = { rowId: row.id, columnId: column.id };
    const value = cellValue(address)!;
    const invalid = store.invalid.get(key(address));
    if (invalid) cell.setAttribute("aria-invalid", "true");
    else cell.removeAttribute("aria-invalid");
    cell.title = invalid?.message ?? "";
    cell.setAttribute("aria-label", `${column.label}${invalid ? `: ${invalid.message}` : ""}`);
    if (value.kind === "boolean" && !invalid) {
      delete cell.dataset.empty;
      if (!cell.firstElementChild?.hasAttribute("data-hubble-boolean")) {
        const slot = document.createElement("span");
        slot.setAttribute("data-hubble-boolean", "");
        cell.replaceChildren(slot);
      }
      return;
    }
    // An alert cell left empty follows the global setting, and shows it dimmed.
    const rule = !invalid && (column.id === "over" || column.id === "lost") ? ruleText(column.id, value.value, store.document.settings) : undefined;
    const shownText = invalid?.edit.value ?? rule?.text ?? value.value;
    if (rule?.inherited) cell.dataset.inherited = "true";
    else delete cell.dataset.inherited;
    if (cell.textContent !== shownText || cell.firstElementChild) cell.textContent = shownText;
    if (!shownText) cell.dataset.empty = "true";
    else delete cell.dataset.empty;
  }

  /**
   * Whether a cell is being typed in: the page's own editor, or Hubble's choice list on a cell.
   * Rows and columns stay as they are until it is finished, so that cell never moves or clears.
   */
  const typing = () => !!editor || !!(document.activeElement as Element | null)?.closest?.("[data-hubble-cell-editor]");
  /** While a cell is being typed in, other windows' saves change only the text of the other cells. */
  function renderValues() {
    for (const row of drawnRows()) {
      const tr = rows.get(row.id)!;
      tr.dataset.off = String(valueOf(row, "enabled") !== "TRUE");
      tr.cells[0]!.setAttribute("aria-label", valueOf(row, "name"));
      for (const column of shown) {
        const cell = cells.get(`${row.id}/${column.id}`);
        if (cell) paint(row, column, cell);
      }
    }
    renderLive();
    controls.refresh();
  }

  function render() {
    if (disposed) return;
    if (typing()) {
      renderValues();
      // Draw the rest once the typing is finished, however it ends.
      deferred ??= setTimeout(function check() {
        deferred = undefined;
        if (disposed) return;
        if (typing()) deferred = setTimeout(check, 200);
        else render();
      }, 200);
      return;
    }
    if (deferred) {
      clearTimeout(deferred);
      deferred = undefined;
    }
    table.style.setProperty("--grid-text-size", `${view().textSize ?? 13}px`);
    if (visibleColumns(view()).map((column) => column.id).join(",") !== shownKey) buildColumns();
    const ids = new Set(options.rows().map((row) => row.id));
    for (const [id, tr] of rows)
      if (!ids.has(id)) {
        tr.remove();
        rows.delete(id);
        for (const column of columns) cells.delete(`${id}/${column.id}`);
      }
    let width = GUTTER;
    for (const column of shown) {
      const columnWidth = widthOf(column.id);
      columnTracks.get(column.id)!.style.width = `${columnWidth}px`;
      width += columnWidth;
      const header = headers.get(column.id)!;
      const heading = headingOf(column);
      if (header.textContent !== heading) header.textContent = heading;
    }
    table.style.width = `${width}px`;
    headers.get("name")!.style.left = `${GUTTER}px`;
    corner.style.left = "0px";
    for (const [index, row] of options.rows().entries()) {
      ensureRow(row);
      const tr = rows.get(row.id)!;
      if (body.children[index] !== tr) body.insertBefore(tr, body.children[index] ?? null);
      tr.style.height = `${view().rowHeights[row.id] ?? ROW_HEIGHT}px`;
      tr.dataset.off = String(valueOf(row, "enabled") !== "TRUE");
      tr.cells[0]!.textContent = String(index + 1);
      tr.cells[0]!.setAttribute("aria-label", valueOf(row, "name"));
      for (const column of shown) {
        const cell = cells.get(`${row.id}/${column.id}`)!;
        if (column.id === "name") cell.style.left = `${GUTTER}px`;
        cell.setAttribute("aria-readonly", String(!!column.live));
        paint(row, column, cell);
      }
    }
    while (body.children.length > options.rows().length) body.lastElementChild!.remove();
    drawn = options.rows().map((row) => row.id);
    pickedRows = pickedRows.filter((id) => ids.has(id));
    markPicked();
    renderLive();
    controls.refresh();
    resize.refresh();
    reorder.refresh();
  }

  const unsubscribe = store.subscribe(render);
  render();
  return {
    refresh: render,
    refreshLive: renderLive,
    select: (address: SpreadsheetAddress, focus = true) => controls.select(address, undefined, focus ? undefined : { focus: false }),
    selected: () => active,
    /** The devices selected: whole rows picked by number, or rows with a selected cell. */
    selectedRows: selectedRowIds,
    dispose() {
      disposed = true;
      clearTimeout(deferred);
      unsubscribe();
      for (const control of disposables.reverse()) control.dispose();
    },
  };
}
