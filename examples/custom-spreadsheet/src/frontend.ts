import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import {
  mountSpreadsheetControls,
  mountSpreadsheetColumnGroup,
  mountSpreadsheetColumnEditor,
  createSpreadsheetContextMenu,
  mountSpreadsheetReorder,
  mountSpreadsheetResize,
  createSpreadsheetWorkbookTools,
  createSpreadsheetWorkbookTransfer,
  mountSpreadsheetToolbar,
  mountSpreadsheetViewport,
  mountSpreadsheetSheets,
  type SpreadsheetToolbar,
  type SpreadsheetWorkbookSnapshot,
  type SpreadsheetResizeControls,
  type SpreadsheetColumnGroup,
  type SpreadsheetAddress,
  type SpreadsheetChoice,
  type SpreadsheetCell,
  type SpreadsheetEdit,
  type SpreadsheetMenuItem,
  type SpreadsheetReorderControls,
  type SpreadsheetReorderItem,
} from "@hubble/module-sdk/spreadsheet-controls";
import {
  columns,
  applyChange,
  routeAvailable,
  readCell,
  type PatchBatch,
  type PatchRow,
  type PatchRowChange,
} from "./model.js";
import { routes, routeAreas } from "./routes.js";
import {
  cleanLayout,
  defaultLayout,
  multipleSheets,
  PatchLayoutSchema,
  withWorksheets,
  type PatchLayout,
  type WorkbookSnapshot,
} from "./workbook-state.js";
import { patchTable, patchCustomTable, patchGroup } from "./table.js";
import "./frontend.css";

// Choose which top-row controls the custom layout should mount.
const toolbarSections = { formula: false, history: false, layout: false };

const root = document.querySelector("table")!;
const viewport = document.querySelector<HTMLElement>(".patch-scroll")!;
const columnTracks = root.querySelector("colgroup")!;
const gutterWidth = 28;
const columnWidths = new Map(Object.entries(defaultLayout.columnWidths));
const rowHeights = new Map<string, number>();
const body = root.tBodies[0]!;
const status = document.querySelector<HTMLOutputElement>("#patch-save-status")!;
const groupHeader = document.querySelector<HTMLTableCellElement>(
  "#patch-details-header",
)!;
const headings = [
  ...root.querySelectorAll<HTMLTableCellElement>("[data-patch-column]"),
];
// This optional declaration gives the shared header its fields and compact view.
// Ordinary columns have no group control.
let columnGroup: SpreadsheetColumnGroup = {
  id: "patch-details",
  label: "Patch details",
  columns: columns.filter(({ id }) => patchGroup.fields.includes(id)),
  expanded: false,
  collapsedColumnIds: ["name"],
};
const groupFieldIds = new Set(columnGroup.columns.map(({ id }) => id));
const plainColumns = columns.filter(({ id }) => !groupFieldIds.has(id));
let columnOrder = [...plainColumns.map(({ id }) => id), columnGroup.id];
const hiddenColumns = new Set<string>();
const client = await connectModuleFrontend(window);
let observed = (await client.call("snapshot")) as WorkbookSnapshot;
const tools = await createSpreadsheetWorkbookTools(patchTable);
const customTools = await createSpreadsheetWorkbookTools(patchCustomTable);
const session = tools.createSession({
  rows: observed.rows,
  view: observed.view,
});
const transfer = await createSpreadsheetWorkbookTransfer(root);
let activeSheet = observed.view.sheets[0]!.id;
let activeCell: SpreadsheetAddress | undefined;
let toolbar: SpreadsheetToolbar | undefined;
let sheets: { refresh(): void; dispose(): void } | undefined;
let viewportControls: { refresh(): void; dispose(): void } | undefined;
let scale = 1;
let rows = new Map(observed.rows.map((row) => [row.id, row]));
const invalid = new Map<
  string,
  { address: SpreadsheetAddress; value: string; message: string }
>();
const display = new Map<string, HTMLTableCellElement>();
const rowElements = new Map<string, HTMLTableRowElement>();
let visibleRows: string[] = [];
let failure = "";
let reorder: SpreadsheetReorderControls | undefined;
let resize: SpreadsheetResizeControls | undefined;
let rowAnchor: string | undefined;
const controlRows = new ResizeObserver(() => {
  resize?.refresh();
  reorder?.refresh();
});

const layout = () => session.current.view as PatchLayout;
const formulaSnapshot = (snapshot = session.current) => ({
  rows: snapshot.rows,
  view: multipleSheets
    ? withWorksheets(observed.nativeView, snapshot.view as PatchLayout)
    : observed.nativeView,
});
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

async function persist(
  next: SpreadsheetWorkbookSnapshot,
  before: SpreadsheetWorkbookSnapshot,
) {
  const previousNativeView = observed.nativeView;
  const nextNativeView = cleanLayout(formulaSnapshot(next).view, next.rows);
  const calculated = await tools.calculate({
    rows: next.rows,
    view: nextNativeView,
  });
  const problem = Object.values(calculated.errors).flatMap(Object.values)[0];
  if (problem) throw new Error(problem);
  const reply = (await client.call("save-workbook", {
    before: {
      rows: before.rows,
      view: before.view,
      nativeView: previousNativeView,
    },
    next: {
      rows: calculated.rows,
      view: cleanLayout(next.view, next.rows),
      nativeView: nextNativeView,
    },
  })) as
    | { status: "saved"; snapshot: WorkbookSnapshot }
    | { status: "rejected"; message: string };
  if (reply.status === "rejected") throw new Error(reply.message);
  if (reply.snapshot.sequence >= observed.sequence) observed = reply.snapshot;
  const after = { rows: reply.snapshot.rows, view: reply.snapshot.view };
  return { ...after, normalization: { before: next, after } };
}
function notify(error: unknown) {
  failure = error instanceof Error ? error.message : String(error);
  render();
}
function commit(
  next: SpreadsheetWorkbookSnapshot,
  failed = notify,
  remap = true,
) {
  failure = "";
  try {
    const rows = remap
      ? tools.remapFormulas(formulaSnapshot(), formulaSnapshot(next))
      : next.rows;
    session.edit({ rows, view: cleanLayout(next.view, rows) }, persist, failed);
  } catch (error) {
    failed(error);
  }
}
function history(direction: "undo" | "redo") {
  failure = "";
  if (direction === "undo" && activeCell && invalid.delete(key(activeCell))) {
    render();
    return;
  }
  session.history(direction === "redo", persist, notify);
  toolbar?.refresh();
}
function setLayout(next: PatchLayout) {
  commit({ rows: session.current.rows, view: PatchLayoutSchema.parse(next) });
}

let editor:
  | {
      address: SpreadsheetAddress;
      cell: HTMLTableCellElement;
      input: HTMLInputElement | HTMLTextAreaElement;
      expected: string;
      expectedFormula: string | null;
    }
  | undefined;
const key = ({ rowId, columnId }: SpreadsheetAddress) => `${rowId}/${columnId}`;
const providers = new Map(
  ["any", "studio", "remote"].map((area) => [
    area,
    async (query: string, signal: AbortSignal) => {
      const result = await client.call("choices", { query, area });
      signal.throwIfAborted();
      return result as unknown as readonly SpreadsheetChoice[];
    },
  ]),
);
const areaChoices = routeAreas.map(({ id, label }) => ({ value: id, label }));

function getCell({
  rowId,
  columnId,
}: SpreadsheetAddress): SpreadsheetCell | null {
  const row = rows.get(rowId);
  const cell = row && readCell(row, columnId);
  if (!row || !cell) return null;
  if (columnId === "route")
    return {
      ...cell,
      choices:
        providers.get(String(row.values.area ?? "any")) ??
        providers.get("any")!,
    };
  if (columnId === "area") return { ...cell, choices: areaChoices };
  return cell;
}

function isColumnVisible(id: string) {
  return (
    !hiddenColumns.has(id) &&
    (!groupFieldIds.has(id) ||
      columnGroup.expanded ||
      columnGroup.collapsedColumnIds.includes(id))
  );
}

function orderedColumns() {
  return columnOrder.flatMap((id) =>
    id === columnGroup.id
      ? columnGroup.columns
      : plainColumns.filter((column) => column.id === id),
  );
}

const controls = await mountSpreadsheetControls({
  root,
  viewport,
  extendedEditing: true,
  workbookEditing: true,
  translateFormula: tools.translateFormula,
  formulaPoint: (address) => tools.coordinate(formulaSnapshot(), address),
  onHistory: history,
  onSelection(address) {
    activeCell = address;
    toolbar?.refresh();
    sheets?.refresh();
  },
  onReferencePick(address) {
    if (
      editor &&
      document.activeElement === editor.input &&
      editor.input.value.startsWith("=") &&
      getCell(editor.address)?.acceptsFormula
    ) {
      if (key(address) === key(editor.address)) return true;
      const reference = tools.reference(
        formulaSnapshot(),
        address,
        editor.address,
      );
      if (!reference) return false;
      const input = editor.input;
      input.setRangeText(
        reference,
        input.selectionStart ?? input.value.length,
        input.selectionEnd ?? input.value.length,
        "end",
      );
      return true;
    }
    return !!toolbar?.pickReference(
      tools.reference(formulaSnapshot(), address, activeCell),
    );
  },
  colorFavorites: {
    get: () => layout().colorFavorites,
    set: (colors) => setLayout({ ...layout(), colorFavorites: [...colors] }),
  },
  getRows: () => visibleRows,
  getColumns: () => orderedColumns().filter(({ id }) => isColumnVisible(id)),
  getCell,
  onEdit: ({ source, edits }) => submit(source, edits),
  onError(error) {
    failure = error.message;
    render();
  },
});

const groupControls = await mountSpreadsheetColumnGroup({
  root: document.querySelector<HTMLElement>("#patch-details-control")!,
  getGroup: () => columnGroup,
  onChange(group) {
    columnGroup = group;
    updateColumnVisibility();
  },
  onError(error) {
    failure = error.message;
    render();
  },
});
const columnEditorSlot = document.querySelector<HTMLElement>(
  "#patch-column-editor",
)!;
controlRows.observe(columnEditorSlot);
const columnEditor = await mountSpreadsheetColumnEditor({
  root: columnEditorSlot,
  getItems: () =>
    columnOrder.map((id) =>
      id === columnGroup.id
        ? {
            id,
            label: columnGroup.label,
            fields: columnGroup.columns.map(({ id, label }) => ({
              id,
              label,
              visible: isColumnVisible(id),
            })),
          }
        : {
            id,
            label: plainColumns.find((column) => column.id === id)!.label,
            visible: isColumnVisible(id),
          },
    ),
  onVisibilityChange: (id, visible) => setColumnVisible(id, visible, false),
  onMove: (id, beforeId) =>
    moveColumns(
      [id],
      beforeId,
      groupFieldIds.has(id) ? columnGroup.id : "columns",
    ),
});

function submit(
  source: PatchBatch["source"],
  edits: readonly SpreadsheetEdit[],
  expected?: { expected: string; expectedFormula: string | null },
): boolean {
  const changes = edits.flatMap((edit) => {
    const cell = getCell(edit);
    if (!cell || cell.readOnly) return [];
    invalid.delete(key(edit));
    const base = expected ?? {
      expected: cell.value,
      expectedFormula: cell.formula ?? null,
    };
    const formula =
      edit.formula ??
      (source === "direct" && cell.acceptsFormula && edit.value.startsWith("=")
        ? edit.value
        : undefined);
    return edit.value === base.expected &&
      (formula ?? null) === base.expectedFormula
      ? []
      : [
          {
            ...edit,
            expected: base.expected,
            expectedFormula: base.expectedFormula,
            ...(formula ? { formula } : {}),
          },
        ];
  });
  const single =
    source === "direct" && changes.length === 1 ? changes[0] : undefined;
  const reject = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (single) {
      const live = getCell(single);
      const unchanged =
        live &&
        live.value === single.expected &&
        (live.formula ?? null) === single.expectedFormula;
      const submitted =
        live &&
        (single.formula
          ? live.formula === single.formula
          : live.value === single.value && !live.formula);
      if (unchanged || submitted)
        invalid.set(key(single), {
          address: single,
          value: single.value,
          message,
        });
    }
    failure = message;
    render();
  };
  try {
    if (!changes.length) {
      failure = "";
      render();
      return true;
    }
    const before = session.current.rows;
    const projected = applyChange(before, { source, edits: changes });
    const next = tools.resetChoices(before, projected, changes);
    if (next.some((row) => !routeAvailable(row)))
      throw new Error("The route is outside this area");
    commit({ ...session.current, rows: next }, reject);
    return true;
  } catch (error) {
    reject(error);
    return false;
  }
}

function syncRows() {
  const next = [...rows.keys()];
  if (
    visibleRows.length === next.length &&
    visibleRows.every((id, i) => id === next[i])
  )
    return;
  if (editor && !rows.has(editor.address.rowId)) {
    editor = undefined;
    failure = "The row was removed before this edit could save";
  }
  for (const [rowId, row] of rowElements) {
    if (rows.has(rowId)) continue;
    row.remove();
    rowElements.delete(rowId);
    for (const column of columns)
      display.delete(key({ rowId, columnId: column.id }));
  }
  visibleRows = next;
  for (const rowId of visibleRows) {
    if (!rowElements.has(rowId)) {
      const row = body.insertRow();
      rowElements.set(rowId, row);
      const height = rowHeights.get(rowId);
      if (height) row.style.height = `${height}px`;
      const handle = document.createElement("th");
      handle.scope = "row";
      handle.dataset.patchRow = rowId;
      handle.title = "Hold to drag row · Option/Alt+Shift+Up or Down to move";
      row.append(handle);
      for (const { id: columnId } of orderedColumns()) {
        const cell = row.insertCell();
        cell.dataset.hubbleRow = rowId;
        cell.dataset.hubbleColumn = columnId;
        cell.setAttribute("role", "gridcell");
        display.set(key({ rowId, columnId }), cell);
      }
    }
  }
  for (const [index, rowId] of visibleRows.entries()) {
    const row = rowElements.get(rowId)!;
    if (body.children[index] !== row)
      body.moveBefore(row, body.children[index] ?? null);
    row.cells[0]!.textContent = String(index + 1);
    row.cells[0]!.setAttribute("aria-label", `Row ${index + 1}`);
  }
}

function render() {
  const view = layout();
  if (!view.sheets.some(({ id }) => id === activeSheet))
    activeSheet = view.sheets[0]!.id;
  const visible = multipleSheets
    ? customTools.rowsForSheet(session.current, activeSheet)
    : session.current.rows;
  rows = new Map(visible.map((row) => [row.id, row]));
  const order = [
    ...view.columnOrder,
    ...columns
      .map(({ id }) => id)
      .filter((id) => !view.columnOrder.includes(id)),
  ];
  columnOrder = [
    ...new Set(
      order
        .map((id) => (groupFieldIds.has(id) ? columnGroup.id : id))
        .filter((id) => id !== "mode"),
    ),
  ];
  const nextGroup = {
    ...columnGroup,
    columns: order.flatMap((id) =>
      groupFieldIds.has(id) ? columns.filter((column) => column.id === id) : [],
    ),
    collapsedColumnIds: view.collapsedFields,
    expanded: view.groupExpansion[columnGroup.id] ?? false,
  };
  if (!same(nextGroup, columnGroup)) {
    columnGroup = nextGroup;
    groupControls.refresh();
  }
  hiddenColumns.clear();
  view.hiddenColumns.forEach((id) => hiddenColumns.add(id));
  for (const column of columns)
    columnWidths.set(
      column.id,
      view.columnWidths[column.id] ??
        defaultLayout.columnWidths[column.id] ??
        160,
    );
  rowHeights.clear();
  Object.entries(view.rowHeights).forEach(([id, height]) =>
    rowHeights.set(id, height),
  );
  root.style.fontSize = `${view.textSize}px`;
  for (const [id, { address }] of invalid) {
    const field = getCell(address);
    if (!field || field.readOnly) invalid.delete(id);
  }
  syncRows();
  for (const [id, row] of rowElements)
    row.style.height = rowHeights.has(id) ? `${rowHeights.get(id)}px` : "";
  syncColumns();
  syncColumnWidths();
  const visibleGroupFields = columnGroup.columns.filter(({ id }) =>
    isColumnVisible(id),
  ).length;
  groupHeader.hidden = visibleGroupFields === 0;
  groupHeader.colSpan = Math.max(1, visibleGroupFields);
  for (const heading of headings)
    heading.hidden = !isColumnVisible(heading.dataset.patchColumn!);
  for (const cell of display.values()) {
    if (cell === editor?.cell) continue;
    const address = addressOf(cell);
    if (!address) continue;
    cell.hidden = !isColumnVisible(address.columnId);
    const field = getCell(address);
    const issue = invalid.get(key(address));
    cell.setAttribute("aria-readonly", String(!field || field.readOnly));
    if (issue) cell.setAttribute("aria-invalid", "true");
    else cell.removeAttribute("aria-invalid");
    cell.title = issue?.message ?? field?.formula ?? "";
    const color =
      field?.kind === "color" && !issue && /^#[\da-f]{6}$/iu.test(field.value)
        ? field.value
        : undefined;
    cell.classList.toggle("patch-color", Boolean(color));
    if (color) {
      cell.style.setProperty("--patch-cell-color", color);
      cell.style.setProperty("--patch-cell-ink", contrastingColorInk(color));
    } else {
      cell.style.removeProperty("--patch-cell-color");
      cell.style.removeProperty("--patch-cell-ink");
    }
    if (field?.kind === "boolean" && !issue) {
      if (!cell.firstElementChild?.hasAttribute("data-hubble-boolean")) {
        const slot = document.createElement("span");
        slot.setAttribute("data-hubble-boolean", "");
        cell.replaceChildren(slot);
      }
      continue;
    }
    cell.textContent =
      issue?.value ??
      (!field
        ? "Unavailable"
        : field.readOnly && !field.value
          ? "Locked"
          : address.columnId === "route"
            ? (routes.find((route) => route.value === field.value)?.label ??
              field.value)
            : address.columnId === "area"
              ? (areaChoices.find(({ value }) => value === field.value)
                  ?.label ?? field.value)
              : field.value);
  }
  const issue = invalid.values().next().value;
  status.textContent =
    failure || issue?.message || (session.pendingCount ? "Saving…" : "");
  status.toggleAttribute("data-error", Boolean(failure || issue));
  status.dataset.accepted = String(observed.batches);
  status.dataset.pending = String(session.pendingCount);
  controls.refresh();
  reorder?.refresh();
  resize?.refresh();
  viewportControls?.refresh();
  toolbar?.refresh();
  columnEditor.refresh();
  sheets?.refresh();
}

function contrastingColorInk(hex: string): string {
  const linearChannel = (start: number) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linearChannel(1) +
    0.7152 * linearChannel(3) +
    0.0722 * linearChannel(5);
  return luminance > 0.38 ? "#111827" : "#FFFFFF";
}

function addressOf(cell: HTMLTableCellElement): SpreadsheetAddress | undefined {
  const { hubbleRow: rowId, hubbleColumn: columnId } = cell.dataset;
  return rowId && columnId ? { rowId, columnId } : undefined;
}

function startEdit(cell: HTMLTableCellElement, initial?: string) {
  const address = addressOf(cell);
  if (!address) return false;
  const field = getCell(address);
  if (
    !field ||
    field.readOnly ||
    field.choices ||
    field.kind === "boolean" ||
    field.kind === "color"
  )
    return false;
  const input = document.createElement(
    address.columnId === "note" ? "textarea" : "input",
  );
  input.className = "cell-input";
  input.setAttribute(
    "aria-label",
    `Edit ${columns.find(({ id }) => id === address.columnId)?.label ?? "cell"}`,
  );
  const issue = invalid.get(key(address));
  input.value = initial ?? issue?.value ?? field.formula ?? field.value;
  if (issue) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-description", issue.message);
  }
  const current = {
    address,
    cell,
    input,
    expected: field.value,
    expectedFormula: field.formula ?? null,
  };
  editor = current;

  const finish = (commit: boolean, focusGrid: boolean) => {
    if (editor !== current) return;
    editor = undefined;
    if (commit) {
      const live = getCell(address);
      if (!live || live.readOnly)
        failure = "The cell became unavailable before this edit could save";
      else submit("direct", [{ ...address, value: input.value }], current);
    }
    render();
    if (focusGrid) controls.select(address);
  };
  input.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || event.isComposing) return;
    if (
      event.key === "Escape" ||
      event.key === "Tab" ||
      (event.key === "Enter" && !event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      finish(event.key !== "Escape", true);
      if (event.key === "Tab") controls.move?.(event.shiftKey ? -1 : 1, 0);
      else if (event.key === "Enter") controls.move?.(0, 1);
    }
  });
  input.addEventListener("blur", () => finish(true, false), { once: true });
  cell.replaceChildren(input);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}

root.addEventListener(
  "keydown",
  (event) => {
    if (
      event.target !== root ||
      event.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    const cell = root.querySelector<HTMLTableCellElement>(
      '[data-hubble-spreadsheet-active="true"]',
    );
    if (!cell) return;
    if (
      (event.key === "F2" || event.key === "Enter" || event.key.length === 1) &&
      startEdit(cell, event.key.length === 1 ? event.key : undefined)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  { capture: true },
);
root.addEventListener("dblclick", (event) => {
  // The range control captures the pointer on the grid during selection.
  // Hit-test the original coordinates when the click is retargeted to the grid.
  const cell = document
    .elementFromPoint(event.clientX, event.clientY)
    ?.closest<HTMLTableCellElement>("td");
  if (cell && root.contains(cell) && !editor) {
    const address = addressOf(cell);
    if (address && getCell(address)?.kind === "color") {
      controls.select(address);
      root.dispatchEvent(
        new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
      );
    } else startEdit(cell);
  }
});

const menu = await createSpreadsheetContextMenu({
  root,
  onError(error) {
    failure = error.message;
    render();
  },
});

function syncColumnWidths() {
  // Use one fixed-width track per visible field. Expansion adds tracks on the
  // right of the group and never redistributes widths to fit the viewport.
  const widths = [
    gutterWidth,
    ...orderedColumns()
      .filter(({ id }) => isColumnVisible(id))
      .map(({ id }) => columnWidths.get(id) ?? 160),
  ];
  while (columnTracks.children.length > widths.length)
    columnTracks.lastElementChild!.remove();
  widths.forEach((width, index) => {
    let track = columnTracks.children[index] as HTMLTableColElement | undefined;
    if (!track) {
      track = document.createElement("col");
      columnTracks.append(track);
    }
    track.style.width = `${width}px`;
  });
  root.style.width = `${widths.reduce((total, width) => total + width, 0)}px`;
}

function syncColumns() {
  const top = root.tHead!.rows[0]!;
  const fields = root.tHead!.rows[1]!;
  const place = (parent: HTMLElement, element: HTMLElement, index: number) => {
    if (parent.children[index] !== element)
      parent.moveBefore(element, parent.children[index] ?? null);
  };
  columnOrder.forEach((id, index) =>
    place(
      top,
      id === columnGroup.id
        ? groupHeader
        : headings.find((heading) => heading.dataset.patchColumn === id)!,
      index + 1,
    ),
  );
  columnGroup.columns.forEach(({ id }, index) =>
    place(
      fields,
      headings.find((heading) => heading.dataset.patchColumn === id)!,
      index,
    ),
  );
  for (const rowId of visibleRows) {
    const row = rowElements.get(rowId)!;
    orderedColumns().forEach(({ id: columnId }, index) =>
      place(row, display.get(key({ rowId, columnId }))!, index + 1),
    );
  }
}

function selectedRows() {
  const visible = orderedColumns().filter(({ id }) => isColumnVisible(id));
  return visibleRows.filter(
    (rowId) =>
      visible.length &&
      visible.every(({ id: columnId }) =>
        display
          .get(key({ rowId, columnId }))
          ?.hasAttribute("data-hubble-spreadsheet-selected"),
      ),
  );
}

function selectRow(rowId: string, extend = false) {
  const visible = orderedColumns().filter(({ id }) => isColumnVisible(id));
  if (!visible.length) return;
  if (!extend && selectedRows().includes(rowId)) {
    root.focus({ preventScroll: true });
    return;
  }
  if (!extend || !rowAnchor || !rows.has(rowAnchor)) rowAnchor = rowId;
  controls.select(
    { rowId: extend ? rowAnchor : rowId, columnId: visible[0]!.id },
    { rowId, columnId: visible.at(-1)!.id },
  );
}

function reorderItems(): SpreadsheetReorderItem[] {
  const columnCells = (ids: string[]) =>
    visibleRows.flatMap((rowId) =>
      ids.map((columnId) => display.get(key({ rowId, columnId }))!),
    );
  const top = columnOrder.flatMap((id): SpreadsheetReorderItem[] => {
    const group = id === columnGroup.id;
    if (group ? groupHeader.hidden : !isColumnVisible(id)) return [];
    const header = group
      ? groupHeader
      : headings.find((heading) => heading.dataset.patchColumn === id)!;
    const ids = group
      ? columnGroup.columns
          .filter(({ id }) => isColumnVisible(id))
          .map(({ id }) => id)
      : [id];
    return [
      {
        id,
        label: group
          ? columnGroup.label
          : plainColumns.find((column) => column.id === id)!.label,
        axis: "column",
        scope: "columns",
        handle: header,
        elements: [
          header,
          ...(group
            ? headings.filter((heading) =>
                ids.includes(heading.dataset.patchColumn!),
              )
            : []),
          ...columnCells(ids),
        ],
      },
    ];
  });
  const fields: SpreadsheetReorderItem[] = columnGroup.columns
    .filter(({ id }) => isColumnVisible(id))
    .map(({ id, label }) => {
      const header = headings.find(
        (heading) => heading.dataset.patchColumn === id,
      )!;
      return {
        id,
        label,
        axis: "column",
        scope: columnGroup.id,
        handle: header,
        elements: [header, ...columnCells([id])],
      };
    });
  return [
    ...top,
    ...fields,
    ...visibleRows.map((id): SpreadsheetReorderItem => {
      const row = rowElements.get(id)!;
      return {
        id,
        label: `Row ${visibleRows.indexOf(id) + 1}`,
        axis: "row",
        handle: row.cells[0]!,
        elements: [...row.cells].filter((cell) => !cell.hidden),
      };
    }),
  ];
}

function moveIds<T extends { id: string }>(
  items: readonly T[],
  ids: readonly string[],
  beforeId: string | null,
): T[] {
  const moving = items.filter(({ id }) => ids.includes(id));
  const rest = items.filter(({ id }) => !ids.includes(id));
  const at =
    beforeId === null
      ? rest.length
      : rest.findIndex(({ id }) => id === beforeId);
  if (at < 0) return [...items];
  rest.splice(at, 0, ...moving);
  return rest;
}

function submitRows(change: PatchRowChange) {
  failure = "";
  try {
    const before = session.current;
    if (change.source === "reorder" && multipleSheets) {
      const ids = new Set(visibleRows);
      const projected = applyChange(
        before.rows.filter((row) => ids.has(row.id)),
        change,
      );
      let at = 0;
      commit({
        ...before,
        rows: before.rows.map((row) =>
          ids.has(row.id) ? projected[at++]! : row,
        ),
      });
    } else
      commit({
        ...before,
        rows: applyChange(before.rows, {
          ...change,
          expectedOrder: before.rows.map((row) => row.id),
        }),
      });
  } catch (error) {
    notify(error);
  }
}
function insertRows(
  beforeId: string | null,
  count: number,
  copies?: readonly string[],
) {
  const before = session.current;
  if (before.rows.length + count > patchTable.maxRows) return;
  const next = [...before.rows];
  const index =
    beforeId === null
      ? next.length
      : next.findIndex((row) => row.id === beforeId);
  if (index < 0) return;
  const offset =
    beforeId === null ? visibleRows.length : visibleRows.indexOf(beforeId);
  const created = copies
    ? before.rows
        .filter((row) => copies.includes(row.id))
        .map(tools.duplicateRow)
    : Array.from({ length: count }, (_, index) =>
        tools.createRow(offset + index),
      );
  next.splice(index, 0, ...created);
  const view = multipleSheets
    ? {
        ...layout(),
        sheetByRowId: {
          ...layout().sheetByRowId,
          ...Object.fromEntries(created.map((row) => [row.id, activeSheet])),
        },
      }
    : layout();
  // Duplicated formulas use the same relative translation as filling a row.
  if (copies) {
    const after = formulaSnapshot({ rows: next, view });
    const from = before.rows.filter((row) => copies.includes(row.id));
    created.forEach((row, i) => {
      const source = from[i]!;
      if (!row.formulas) return;
      for (const id of Object.keys(row.formulas)) {
        const origin = tools.coordinate(formulaSnapshot(before), {
          rowId: source.id,
          columnId: id,
        });
        const destination = tools.coordinate(after, {
          rowId: row.id,
          columnId: id,
        });
        if (origin && destination)
          row.formulas[id] = tools.translateFormula(
            row.formulas[id]!,
            destination.column - origin.column,
            destination.row - origin.row,
          );
      }
    });
  }
  commit({ rows: next, view });
}
function copyWorkbook() {
  const encoded = JSON.parse(tools.copyWorkbook(formulaSnapshot()));
  transfer.copy(
    JSON.stringify({
      ...encoded,
      customView: cleanLayout(layout(), session.current.rows),
    }),
  );
}
function pasteWorkbook(text: string) {
  const copied = tools.pasteWorkbook(text);
  const payload = JSON.parse(text) as {
    rows: { id: string }[];
    customView?: PatchLayout;
  };
  const original = payload.customView
    ? PatchLayoutSchema.parse(payload.customView)
    : defaultLayout;
  const ids = new Map(
    payload.rows.map(({ id }, index) => [id, copied.rows[index]!.id]),
  );
  const remap = <T>(record: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(record).flatMap(([id, value]) =>
        ids.has(id) ? [[ids.get(id)!, value]] : [],
      ),
    );
  const view = PatchLayoutSchema.parse({
    ...original,
    rowHeights: remap(original.rowHeights),
    ...(multipleSheets
      ? { sheets: copied.view.sheets, sheetByRowId: copied.view.sheetByRowId }
      : { sheetByRowId: remap(original.sheetByRowId) }),
  });
  const next = { rows: copied.rows, view };
  const rows = tools.remapFormulas(copied, formulaSnapshot(next));
  commit({ ...next, rows }, notify, false);
}
function saveColumnLayout() {
  setLayout({
    ...layout(),
    columnOrder: orderedColumns().map(({ id }) => id),
    hiddenColumns: [...hiddenColumns],
    collapsedFields: [...columnGroup.collapsedColumnIds],
    groupExpansion: {
      ...layout().groupExpansion,
      [columnGroup.id]: columnGroup.expanded,
    },
  });
}
function updateColumnVisibility(focusGrid = true) {
  const address = activeCell;
  saveColumnLayout();
  if (address && !isColumnVisible(address.columnId)) {
    const next = orderedColumns().find(({ id }) => isColumnVisible(id))?.id;
    if (next)
      controls.select({ rowId: address.rowId, columnId: next }, undefined, {
        focus: focusGrid,
      });
  }
}

function setColumnVisible(id: string, visible: boolean, focusGrid = true) {
  if (isColumnVisible(id) === visible) return;
  if (visible) {
    hiddenColumns.delete(id);
    if (
      groupFieldIds.has(id) &&
      !columnGroup.expanded &&
      !columnGroup.collapsedColumnIds.includes(id)
    ) {
      columnGroup = {
        ...columnGroup,
        collapsedColumnIds: [...columnGroup.collapsedColumnIds, id],
      };
      groupControls.refresh();
    }
  } else hiddenColumns.add(id);
  updateColumnVisibility(focusGrid);
}

function moveColumns(
  ids: readonly string[],
  beforeId: string | null,
  scope: string | undefined,
) {
  if (scope === columnGroup.id) {
    columnGroup = {
      ...columnGroup,
      columns: moveIds(columnGroup.columns, ids, beforeId),
    };
    groupControls.refresh();
  } else
    columnOrder = moveIds(
      columnOrder.map((id) => ({ id })),
      ids,
      beforeId,
    ).map(({ id }) => id);
  saveColumnLayout();
}

function openCellMenu(cell: HTMLTableCellElement, x: number, y: number) {
  const address = addressOf(cell);
  if (!address) return;
  // Match Matrix: keep the range if it contains the clicked cell.
  if (!cell.matches('[data-hubble-spreadsheet-selected="true"]'))
    controls.select(address);
  const field = getCell(address);
  const issue = invalid.get(key(address));
  const selected = [
    ...root.querySelectorAll<HTMLTableCellElement>(
      '[data-hubble-spreadsheet-selected="true"]',
    ),
  ].flatMap((item) => {
    const target = addressOf(item);
    const value = target && getCell(target);
    return target && value && !value.readOnly ? [{ ...target, value: "" }] : [];
  });
  menu.open({
    x,
    y,
    label:
      selected.length > 1
        ? `${selected.length} editable cells`
        : (columns.find(({ id }) => id === address.columnId)?.label ?? "Cell"),
    issue: issue?.message,
    items: [
      {
        id: "edit",
        label: field?.choices
          ? "Choose value"
          : field?.kind === "boolean"
            ? "Toggle check mark"
            : field?.kind === "color"
              ? "Edit color"
              : "Edit cell",
        disabled: !field || field.readOnly,
        run() {
          controls.select(address);
          if (field?.choices || field?.kind === "color")
            root.dispatchEvent(
              new KeyboardEvent("keydown", { key: "F2", bubbles: true }),
            );
          else if (field?.kind === "boolean")
            submit("toggle", [
              { ...address, value: field.value === "TRUE" ? "FALSE" : "TRUE" },
            ]);
          else startEdit(cell);
        },
      },
      {
        id: "clear",
        label: selected.length > 1 ? "Clear cells" : "Clear cell",
        danger: true,
        disabled: !selected.length,
        run: () => controls.clear?.(),
      },
      ...(issue
        ? [
            {
              id: "discard",
              label: "Discard invalid entry",
              run() {
                invalid.delete(key(address));
                render();
              },
            },
          ]
        : []),
    ],
  });
}
function menuTarget(event: MouseEvent) {
  const target = event.target;
  return target instanceof Element && !target.closest("input, textarea")
    ? target.closest<HTMLTableCellElement>("td, th")
    : null;
}
function openPointerMenu(cell: HTMLTableCellElement, event: MouseEvent) {
  if (cell.tagName === "TD") openCellMenu(cell, event.clientX, event.clientY);
  else openHeaderMenu(cell, event.clientX, event.clientY);
}

function openHeaderMenu(cell: HTMLTableCellElement, x: number, y: number) {
  if (cell === groupHeader) return; // Shared group owns Expand and Collapsed fields.
  const rowId = cell.dataset.patchRow;
  if (rowId) {
    selectRow(rowId);
    const ids = selectedRows();
    const below = visibleRows[visibleRows.indexOf(rowId) + 1] ?? null;
    const insert = (beforeId: string | null) => insertRows(beforeId, 1);
    menu.open({
      x,
      y,
      label: ids.length > 1 ? `${ids.length} rows` : "Row",
      items: [
        {
          id: "above",
          label: "Insert row above",
          icon: "add",
          disabled: rows.size >= patchTable.maxRows,
          run: () => insert(rowId),
        },
        {
          id: "below",
          label: "Insert row below",
          icon: "add",
          disabled: rows.size >= patchTable.maxRows,
          run: () =>
            insert(visibleRows[visibleRows.indexOf(rowId) + 1] ?? null),
        },
        {
          id: "bottom",
          label: "Add row at bottom",
          icon: "add",
          disabled: rows.size >= patchTable.maxRows,
          run: () => insert(null),
        },
        {
          id: "bulk",
          label: "Insert multiple rows",
          icon: "add",
          items: [
            ["Above", rowId],
            ["Below", below],
            ["At bottom", null],
          ].map(([label, beforeId]) => ({
            id: String(label),
            label: String(label),
            items: [2, 5, 10].map((count) => ({
              id: String(count),
              label: `Insert ${count} rows`,
              disabled:
                session.current.rows.length + count > patchTable.maxRows,
              run: () => insertRows(beforeId, count),
            })),
          })),
        },
        {
          id: "duplicate",
          label: ids.length > 1 ? "Duplicate rows" : "Duplicate row",
          disabled:
            session.current.rows.length + ids.length > patchTable.maxRows,
          run: () => insertRows(below, ids.length, ids),
        },
        { separator: true },
        {
          id: "delete",
          label: ids.length > 1 ? "Delete rows" : "Delete row",
          icon: "delete",
          danger: true,
          run: () =>
            submitRows({
              source: "remove",
              ids,
              expectedOrder: [...visibleRows],
            }),
        },
      ],
    });
    return;
  }
  const id = cell.dataset.patchColumn;
  const items: SpreadsheetMenuItem[] = [];
  if (!visibleRows.length) {
    items.push({
      id: "bottom",
      label: "Add row at bottom",
      icon: "add",
      run: () => insertRows(null, 1),
    });
  }
  if (id) {
    items.push({
      id: "hide",
      label: "Hide column",
      run: () => setColumnVisible(id, false),
    });
  }
  const hidden = orderedColumns().filter(({ id }) => !isColumnVisible(id));
  if (hidden.length) {
    items.push({
      id: "show",
      label: "Hidden columns",
      items: hidden.map(({ id, label }) => ({
        id,
        label,
        run: () => setColumnVisible(id, true),
      })),
    });
  }
  if (groupFieldIds.has(id ?? "") || !id) {
    items.push({
      id: "expand",
      label: columnGroup.expanded
        ? "Collapse Patch details"
        : "Expand Patch details",
      run() {
        columnGroup = { ...columnGroup, expanded: !columnGroup.expanded };
        groupControls.refresh();
        updateColumnVisibility();
      },
    });
  }
  if (!id) {
    items.push(
      { separator: true },
      { id: "copy-workbook", label: "Copy workbook", run: copyWorkbook },
      {
        id: "paste-workbook",
        label: "Paste workbook…",
        run: () => transfer.paste(pasteWorkbook),
      },
    );
  }
  menu.open({
    x,
    y,
    label: columns.find((column) => column.id === id)?.label ?? "Columns",
    items,
  });
}
root.addEventListener(
  "pointerdown",
  (event) => {
    if (
      event.button !== 2 &&
      !(event.button === 0 && event.ctrlKey && /Mac/.test(navigator.platform))
    )
      return;
    const cell = menuTarget(event);
    if (!cell || cell === groupHeader) return;
    event.preventDefault();
    event.stopPropagation();
    openPointerMenu(cell, event);
  },
  true,
);
root.addEventListener(
  "contextmenu",
  (event) => {
    const cell = menuTarget(event);
    if (!cell || cell === groupHeader) return;
    event.preventDefault();
    openPointerMenu(cell, event);
  },
  true,
);
root.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return;
  const cell =
    event.target === root
      ? root.querySelector<HTMLTableCellElement>(
          '[data-hubble-spreadsheet-active="true"]',
        )
      : event.target instanceof HTMLTableCellElement
        ? event.target
        : null;
  if (!cell) return;
  event.preventDefault();
  const { left, bottom } = cell.getBoundingClientRect();
  if (cell.tagName === "TH") openHeaderMenu(cell, left, bottom);
  else openCellMenu(cell, left, bottom);
});

const unsubscribeWorkbook = session.subscribe(render);
const unsubscribe = client.subscribe((state) => {
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const values = state.values;
  if (
    !values ||
    typeof values !== "object" ||
    Array.isArray(values) ||
    !values.patch
  )
    return;
  const next = values.patch as WorkbookSnapshot;
  if (next.sequence < observed.sequence) return;
  observed = next;
  session.observe({ rows: next.rows, view: next.view });
});
window.addEventListener(
  "pagehide",
  () => {
    unsubscribe();
    unsubscribeWorkbook();
    controlRows.disconnect();
    toolbar?.dispose();
    sheets?.dispose();
    viewportControls?.dispose();
    transfer.dispose();
    menu.dispose();
    reorder?.dispose();
    resize?.dispose();
    groupControls.dispose();
    columnEditor.dispose();
    controls.dispose();
    client.dispose();
  },
  { once: true },
);
render();
reorder = await mountSpreadsheetReorder({
  root,
  getItems: reorderItems,
  getSelectedRows: selectedRows,
  onSelect(item, extend) {
    if (item.axis === "row") selectRow(item.id, extend);
    else if (visibleRows.length) {
      const ids =
        item.id === columnGroup.id
          ? columnGroup.columns
              .filter(({ id }) => isColumnVisible(id))
              .map(({ id }) => id)
          : [item.id];
      controls.select(
        { rowId: visibleRows[0]!, columnId: ids[0]! },
        { rowId: visibleRows.at(-1)!, columnId: ids.at(-1)! },
      );
    }
  },
  onMove({ axis, scope, ids, beforeId }) {
    if (axis === "row")
      submitRows({
        source: "reorder",
        ids: [...ids],
        beforeId,
        expectedOrder: [...visibleRows],
      });
    else moveColumns(ids, beforeId, scope);
  },
  onError(error) {
    failure = error.message;
    render();
  },
});

resize = await mountSpreadsheetResize({
  root,
  viewport,
  getItems: () => [
    ...headings.flatMap((header) => {
      const id = header.dataset.patchColumn!;
      if (header.hidden) return [];
      return [
        {
          id,
          header,
          axis: "column" as const,
          label: header.textContent ?? id,
          size: header.getBoundingClientRect().width / scale,
          min: 76,
          max: 640,
        },
      ];
    }),
    ...visibleRows.map((id, index) => {
      const header = rowElements.get(id)!.cells[0]!;
      return {
        id,
        header,
        axis: "row" as const,
        label: `Row ${index + 1}`,
        size: header.getBoundingClientRect().height / scale,
        min: 37,
        max: 240,
      };
    }),
  ],
  getScale: () => scale,
  onResize({ id, axis }, size) {
    const view = layout();
    if (axis === "column")
      setLayout({
        ...view,
        columnWidths: { ...view.columnWidths, [id]: size },
      });
    else setLayout({ ...view, rowHeights: { ...view.rowHeights, [id]: size } });
  },
});

if (
  toolbarSections.formula ||
  toolbarSections.history ||
  toolbarSections.layout
) {
  const slot = document.createElement("div");
  viewport.before(slot);
  controlRows.observe(slot);
  toolbar = await mountSpreadsheetToolbar({
    root: slot,
    ...(toolbarSections.formula && {
      getSource() {
        if (!activeCell) return;
        const cell = getCell(activeCell);
        if (!cell) return;
        const issue = invalid.get(key(activeCell));
        return {
          id: key(activeCell),
          reference: tools.reference(formulaSnapshot(), activeCell),
          value: issue?.value ?? cell.formula ?? cell.value,
          resolved: cell.value,
          editable:
            !cell.readOnly &&
            !cell.choices &&
            cell.kind !== "color" &&
            cell.kind !== "boolean",
        };
      },
      onSource(value) {
        return activeCell && submit("direct", [{ ...activeCell, value }]);
      },
      onFocusGrid: () => root.focus({ preventScroll: true }),
    }),
    ...(toolbarSections.history && {
      getHistory: () => ({
        undo: !!session.undo.length,
        redo: !!session.redo.length,
      }),
      onHistory: history,
    }),
    ...(toolbarSections.layout && {
      layout: {
        get: layout,
        onChange: (update) => setLayout({ ...layout(), ...update }),
      },
    }),
  });
}

viewportControls = await mountSpreadsheetViewport({
  root,
  viewport,
  getFrozen() {
    const count = layout().frozenColumns;
    if (!count) return [];
    const visible = orderedColumns().filter(({ id }) => isColumnVisible(id));
    // Freeze a group as a unit when the split falls inside it.
    const boundary = visible[count - 1];
    const fixed = groupFieldIds.has(boundary?.id ?? "")
      ? visible.slice(
          0,
          visible.findLastIndex(({ id }) => groupFieldIds.has(id)) + 1,
        )
      : visible.slice(0, count);
    const result = [
      ...root.querySelectorAll<HTMLElement>(".row-corner, [data-patch-row]"),
    ].map((element) => ({ element, left: 0 }));
    let left = gutterWidth;
    for (const { id } of fixed) {
      const heading = headings.find(
        (header) => header.dataset.patchColumn === id,
      )!;
      if (
        groupFieldIds.has(id) &&
        !result.some(({ element }) => element === groupHeader)
      )
        result.push({ element: groupHeader, left });
      result.push({ element: heading, left });
      for (const rowId of visibleRows) {
        const cell = display.get(key({ rowId, columnId: id }));
        if (cell) result.push({ element: cell, left });
      }
      left += columnWidths.get(id) ?? 160;
    }
    return result;
  },
  onZoom(ratio) {
    scale = ratio;
    controls.refresh();
    resize?.refresh();
    reorder?.refresh();
  },
});

if (multipleSheets) {
  const selectSheet = (id: string) => {
    activeSheet = id;
    activeCell = undefined;
    render();
  };
  sheets = await mountSpreadsheetSheets({
    root: document.querySelector<HTMLElement>("#patch-sheets")!,
    getState: () => ({
      sheets: layout().sheets,
      activeSheetId: activeSheet,
      counts: new Map(
        layout().sheets.map(({ id }) => [
          id,
          customTools.rowsForSheet(session.current, id).length,
        ]),
      ),
      canMoveSelection: selectedRows().length > 0,
    }),
    onSelect: selectSheet,
    onCreate(name) {
      const id = crypto.randomUUID();
      setLayout({ ...layout(), sheets: [...layout().sheets, { id, name }] });
      selectSheet(id);
    },
    onRename(id, name) {
      setLayout({
        ...layout(),
        sheets: layout().sheets.map((sheet) =>
          sheet.id === id ? { id, name } : sheet,
        ),
      });
    },
    onRemove(id) {
      setLayout(customTools.removeSheet(session.current, id) as PatchLayout);
    },
    onReorder(id, before) {
      const view = layout();
      setLayout({
        ...view,
        sheets: moveIds(view.sheets, [id], before),
        sheetByRowId: Object.fromEntries(
          session.current.rows.map(({ id: rowId }) => [
            rowId,
            view.sheetByRowId[rowId] ?? view.sheets[0]!.id,
          ]),
        ),
      });
    },
    onMoveSelection(id) {
      setLayout({
        ...layout(),
        sheetByRowId: {
          ...layout().sheetByRowId,
          ...Object.fromEntries(selectedRows().map((row) => [row, id])),
        },
      });
    },
  });
}
