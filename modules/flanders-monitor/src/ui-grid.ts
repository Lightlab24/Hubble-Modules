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
import type { Statuses } from "./backend.js";
import type { DraftStore } from "./draft-store.js";
import {
  clearedValue,
  clone,
  columns,
  idleStatus,
  moveRows,
  valueOf,
  whenInUseChoices,
  type CellEdit,
  type MonitorRow,
  type View,
} from "./model.js";

export interface GridOptions {
  readonly table: HTMLTableElement;
  readonly viewport: HTMLElement;
  readonly store: DraftStore;
  statuses(): Statuses;
  onInsert(beforeId: string | null): void;
  onRemove(rowId: string): void;
  onError(message: string): void;
}

const GUTTER = 34;
const ROW_HEIGHT = 36;
const key = (address: SpreadsheetAddress) => `${address.rowId}/${address.columnId}`;
const labelOf = (columnId: string) => columns.find((column) => column.id === columnId)?.label ?? columnId;
// One stable provider, so the shared choice editor isn't rebuilt on every refresh.
const whenInUseProvider = async (query: string, signal: AbortSignal) => {
  signal.throwIfAborted();
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  return whenInUseChoices.filter((choice) => words.every((word) => `${choice.label} ${choice.value}`.toLowerCase().includes(word)));
};

/**
 * The monitor list, drawn by the page and edited through Hubble's shared
 * spreadsheet controls: selection, fill, clipboard, choice editor, checkboxes,
 * menus, resize, row moves and zoom are the same as in the Button Matrix.
 */
export async function createMonitorGrid(options: GridOptions) {
  const { table, viewport, store } = options;
  const tracks = table.querySelector("colgroup")!;
  const head = table.createTHead();
  const headerRow = head.insertRow();
  const body = table.createTBody();
  const rows = new Map<string, HTMLTableRowElement>();
  const cells = new Map<string, HTMLTableCellElement>();
  const headers = new Map<string, HTMLTableCellElement>();
  const disposables: { dispose(): void }[] = [];
  let active: SpreadsheetAddress | undefined;
  let editor: { address: SpreadsheetAddress; cell: HTMLTableCellElement } | undefined;
  let disposed = false;
  let zoom = 1;

  const view = () => store.document.view;
  const widthOf = (columnId: string) => view().widths[columnId] ?? columns.find((column) => column.id === columnId)!.width;
  const rowOf = (id: string) => store.document.monitors.find((row) => row.id === id);

  function statusOf(row: MonitorRow) {
    const status = options.statuses()[row.id];
    return status && status.host === valueOf(row, "host") && status.port === valueOf(row, "port") ? status : undefined;
  }

  function cellValue(address: SpreadsheetAddress): SpreadsheetCell | null {
    const row = rowOf(address.rowId);
    if (!row) return null;
    switch (address.columnId) {
      case "name":
      case "host":
      case "port":
        return { value: valueOf(row, address.columnId) };
      case "enabled":
        return { value: valueOf(row, "enabled"), kind: "boolean" };
      case "whenInUse":
        return { value: valueOf(row, "whenInUse"), choices: whenInUseProvider };
      case "status":
        return { value: statusOf(row)?.text ?? idleStatus(row), readOnly: true };
      default:
        return null;
    }
  }

  function submit(edits: readonly SpreadsheetEdit[], expected?: string): boolean {
    const changes: CellEdit[] = edits.flatMap((edit) => {
      const row = rowOf(edit.rowId);
      const cell = cellValue(edit);
      if (!row || !cell || cell.readOnly) return [];
      const value = edit.value === "" ? clearedValue(edit.columnId) : edit.value;
      return [{ rowId: edit.rowId, columnId: edit.columnId, value, expected: expected ?? valueOf(row, edit.columnId) }];
    });
    // Putting back the saved value is no change to save, but it does settle a red draft in that cell.
    for (const change of changes)
      if (change.value === change.expected && store.invalid.has(key(change))) store.discard(change.rowId, change.columnId);
    const real = changes.filter((change) => change.value !== change.expected);
    return real.length ? store.submit({ kind: "edit", edits: real }) : true;
  }

  function layout(next: View) {
    store.submit({ kind: "view", view: next, expected: clone(view()) });
  }

  // Header: the row-number corner, then one header per column.
  const corner = document.createElement("th");
  corner.className = "row-number corner";
  corner.setAttribute("aria-label", "Monitor rows");
  headerRow.append(corner);
  const gutterTrack = document.createElement("col");
  gutterTrack.style.width = `${GUTTER}px`;
  tracks.append(gutterTrack);
  const columnTracks = new Map<string, HTMLTableColElement>();
  for (const column of columns) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = column.label;
    th.dataset.columnId = column.id;
    th.tabIndex = 0;
    if (column.id === "name") th.className = "frozen";
    headers.set(column.id, th);
    headerRow.append(th);
    const track = document.createElement("col");
    columnTracks.set(column.id, track);
    tracks.append(track);
  }

  // Draw the saved rows before mounting, so every control finds its cells.
  for (const row of store.document.monitors) {
    ensureRow(row);
    body.append(rows.get(row.id)!);
  }
  const controls: SpreadsheetControls = await mountSpreadsheetControls({
    root: table,
    viewport,
    extendedEditing: true,
    workbookEditing: true,
    getRows: () => store.document.monitors.map((row) => row.id),
    getColumns: () => columns.map((column) => ({ id: column.id, label: column.label, fill: column.fill })),
    getCell: cellValue,
    onEdit: (batch) => {
      submit(batch.edits);
    },
    onSelection(address) {
      active = address;
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
    const rowId = target?.dataset.rowId;
    if (!rowId) return;
    event.preventDefault();
    const index = store.document.monitors.findIndex((row) => row.id === rowId);
    const columnId = target.dataset.columnId;
    menu.open({
      x: event.clientX,
      y: event.clientY,
      label: valueOf(rowOf(rowId)!, "name") || "Monitor",
      items: [
        ...(columnId && columnId !== "status" && columnId !== "enabled" && columnId !== "whenInUse"
          ? [{ id: "edit", label: "Edit cell", run: () => startEdit(target) }]
          : []),
        ...(columnId && store.invalid.has(`${rowId}/${columnId}`)
          ? [{ id: "discard", label: "Discard invalid draft", run: () => store.discard(rowId, columnId) }]
          : []),
        { id: "above", label: "Add monitor above", icon: "add", run: () => options.onInsert(rowId) },
        { id: "below", label: "Add monitor below", icon: "add", run: () => options.onInsert(store.document.monitors[index + 1]?.id ?? null) },
        { separator: true },
        { id: "remove", label: "Remove monitor", icon: "delete", danger: true, run: () => options.onRemove(rowId) },
      ],
    });
  });

  const resize = await mountSpreadsheetResize({
    root: table,
    viewport,
    getScale: () => zoom,
    getItems: () => [
      ...columns.map((column) => ({
        id: column.id,
        label: column.label,
        axis: "column" as const,
        header: headers.get(column.id)!,
        size: widthOf(column.id),
        min: 60,
        max: 800,
      })),
      // Only rows already drawn: the controls ask while mounting, before the first render.
      ...store.document.monitors.filter((row) => rows.has(row.id)).map((row) => ({
        id: row.id,
        label: valueOf(row, "name"),
        axis: "row" as const,
        header: rows.get(row.id)!.cells[0] as HTMLElement,
        size: view().rowHeights[row.id] ?? ROW_HEIGHT,
        min: 28,
        max: 200,
      })),
    ],
    onResize(item, size) {
      const next = clone(view());
      if (item.axis === "column") next.widths[item.id] = Math.round(size);
      else next.rowHeights[item.id] = Math.round(size);
      layout(next);
    },
  });
  disposables.push(resize);

  const reorder = await mountSpreadsheetReorder({
    root: table,
    getItems: () =>
      store.document.monitors.filter((row) => rows.has(row.id)).map((row) => ({
        id: row.id,
        label: valueOf(row, "name"),
        axis: "row" as const,
        handle: rows.get(row.id)!.cells[0] as HTMLElement,
        elements: [...rows.get(row.id)!.cells] as HTMLElement[],
      })),
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

  /** The package's own text editor for Monitor, IP address and Port. */
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
    input.setAttribute("aria-label", `Edit ${labelOf(columnId)}`);
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

  function ensureRow(row: MonitorRow) {
    if (rows.has(row.id)) return;
    const tr = document.createElement("tr");
    tr.dataset.rowId = row.id;
    const number = document.createElement("th");
    number.scope = "row";
    number.className = "row-number";
    number.dataset.rowId = row.id;
    tr.append(number);
    for (const column of columns) {
      const cell = tr.insertCell();
      cell.setAttribute("role", "gridcell");
      cell.dataset.rowId = row.id;
      cell.dataset.columnId = column.id;
      cell.dataset.hubbleRow = row.id;
      cell.dataset.hubbleColumn = column.id;
      if (column.id === "name") cell.className = "frozen";
      cells.set(`${row.id}/${column.id}`, cell);
    }
    rows.set(row.id, tr);
  }

  function render() {
    if (disposed) return;
    table.style.setProperty("--grid-text-size", `${view().textSize ?? 13}px`);
    const ids = new Set(store.document.monitors.map((row) => row.id));
    for (const [id, tr] of rows)
      if (!ids.has(id)) {
        tr.remove();
        rows.delete(id);
        for (const column of columns) cells.delete(`${id}/${column.id}`);
      }
    let width = GUTTER;
    for (const column of columns) {
      const columnWidth = widthOf(column.id);
      columnTracks.get(column.id)!.style.width = `${columnWidth}px`;
      width += columnWidth;
    }
    table.style.width = `${width}px`;
    headers.get("name")!.style.left = `${GUTTER}px`;
    corner.style.left = "0px";
    for (const [index, row] of store.document.monitors.entries()) {
      ensureRow(row);
      const tr = rows.get(row.id)!;
      if (body.children[index] !== tr) body.insertBefore(tr, body.children[index] ?? null);
      tr.style.height = `${view().rowHeights[row.id] ?? ROW_HEIGHT}px`;
      tr.cells[0]!.textContent = String(index + 1);
      tr.cells[0]!.setAttribute("aria-label", valueOf(row, "name"));
      for (const column of columns) {
        const cell = cells.get(`${row.id}/${column.id}`)!;
        if (column.id === "name") cell.style.left = `${GUTTER}px`;
        if (cell === editor?.cell) continue;
        const address = { rowId: row.id, columnId: column.id };
        const value = cellValue(address)!;
        const invalid = store.invalid.get(key(address));
        cell.setAttribute("aria-readonly", String(!!value.readOnly));
        if (invalid) cell.setAttribute("aria-invalid", "true");
        else cell.removeAttribute("aria-invalid");
        cell.title = invalid?.message ?? "";
        cell.setAttribute("aria-label", `${column.label}${invalid ? `: ${invalid.message}` : ""}`);
        if (column.id === "status") {
          const tone = statusOf(row)?.tone;
          if (tone) cell.dataset.tone = tone;
          else delete cell.dataset.tone;
        }
        if (value.kind === "boolean" && !invalid) {
          delete cell.dataset.empty;
          if (!cell.firstElementChild?.hasAttribute("data-hubble-boolean")) {
            const slot = document.createElement("span");
            slot.setAttribute("data-hubble-boolean", "");
            cell.replaceChildren(slot);
          }
          continue;
        }
        cell.textContent =
          invalid?.edit.value ?? (column.id === "whenInUse" ? whenInUseChoices.find((choice) => choice.value === value.value)?.label : undefined) ?? value.value;
        if (!cell.textContent && !value.readOnly) cell.dataset.empty = "true";
        else delete cell.dataset.empty;
      }
    }
    while (body.children.length > store.document.monitors.length) body.lastElementChild!.remove();
    controls.refresh();
    resize.refresh();
    reorder.refresh();
  }

  const unsubscribe = store.subscribe(render);
  render();
  return {
    refresh: render,
    select: (address: SpreadsheetAddress) => controls.select(address),
    dispose() {
      disposed = true;
      unsubscribe();
      for (const control of disposables.reverse()) control.dispose();
    },
  };
}
