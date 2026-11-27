import type {
  ModulePageTable,
  ModuleTableRow,
  ModuleTableViewState,
} from "./index.js";
/** Host-rendered interaction controls for a package-owned layout. API feature v1. */
export const MODULE_SPREADSHEET_CONTROLS_FEATURE =
  "module-spreadsheet-controls-v1";
export const MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE =
  "module-spreadsheet-column-groups-v1";
export const MODULE_SPREADSHEET_COLUMN_EDITOR_FEATURE =
  "module-spreadsheet-column-editor-v1";
export const MODULE_SPREADSHEET_COLUMN_VISIBILITY_FEATURE =
  "module-spreadsheet-column-visibility-v1";
export const MODULE_SPREADSHEET_COLUMN_PAINT_FEATURE =
  "module-spreadsheet-column-paint-v1";
export const MODULE_SPREADSHEET_COLUMN_SEARCH_FEATURE =
  "module-spreadsheet-column-search-v1";
/** The Button Matrix's search field: Find, Rows and Columns. */
export const MODULE_SPREADSHEET_SEARCH_FEATURE = "module-spreadsheet-search-v1";
/** Undo and redo that Hubble keeps for a grid mounted with `history`. */
export const MODULE_SPREADSHEET_HISTORY_FEATURE =
  "module-spreadsheet-history-v1";
export const MODULE_SPREADSHEET_COLUMN_SECTIONS_FEATURE =
  "module-spreadsheet-column-sections-v1";
export const MODULE_SPREADSHEET_TEXT_SIZE_FEATURE =
  "module-spreadsheet-text-size-v1";
export const MODULE_SPREADSHEET_WORKBOOK_TOOLS_FEATURE =
  "module-spreadsheet-workbook-tools-v1";
export const MODULE_SPREADSHEET_TOOLBAR_SECTIONS_FEATURE =
  "module-spreadsheet-toolbar-sections-v1";
export const MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE =
  "module-spreadsheet-extended-editing-v1";
export const MODULE_SPREADSHEET_LAYOUT_FEATURE = "module-spreadsheet-layout-v1";

export interface SpreadsheetAddress {
  readonly rowId: string;
  readonly columnId: string;
}
export interface SpreadsheetChoice {
  /** Stable stored and clipboard value. Labels may change or be duplicated. */
  readonly value: string;
  readonly label: string;
  readonly group?: string;
}
export interface SpreadsheetCell {
  readonly value: string;
  readonly readOnly?: boolean;
  /** Checkbox cells use TRUE/FALSE on the wire. */
  readonly kind?: "boolean" | "color";
  readonly formula?: string;
  readonly acceptsFormula?: boolean;
  readonly choices?:
    | readonly SpreadsheetChoice[]
    | ((
        query: string,
        signal: AbortSignal,
      ) =>
        readonly SpreadsheetChoice[] | Promise<readonly SpreadsheetChoice[]>);
}
export interface SpreadsheetColumn {
  readonly id: string;
  readonly label: string;
  /** Defaults to copy. Choice cells always copy their stable IDs. */
  readonly fill?: "copy" | "series";
}
export interface SpreadsheetColumnGroup {
  readonly id: string;
  readonly label: string;
  /** All fields in this group, in display order. */
  readonly columns: readonly SpreadsheetColumn[];
  readonly expanded: boolean;
  /** Empty keeps only the module-owned header. Requires column-visibility-v1. */
  readonly collapsedColumnIds: readonly string[];
}
export interface SpreadsheetColumnGroupOptions {
  /** An empty, module-owned header slot. Plain columns need no group control. */
  readonly root: HTMLElement;
  getGroup(): SpreadsheetColumnGroup;
  /** Update the visible layout immediately, then queue any module-owned save. */
  onChange(group: SpreadsheetColumnGroup): void;
  onError?(error: Error): void;
}
export interface SpreadsheetColumnGroupControls {
  refresh(): void;
  dispose(): void;
}
export interface SpreadsheetEdit extends SpreadsheetAddress {
  readonly value: string;
  readonly formula?: string;
}
export interface SpreadsheetEditBatch {
  /** `undo` and `redo` reach only a grid mounted with `history`. */
  readonly source:
    | "choice"
    | "paste"
    | "fill"
    | "clear"
    | "toggle"
    | "cut"
    | "color"
    | "undo"
    | "redo";
  readonly edits: readonly SpreadsheetEdit[];
}
/**
 * A change that is not a cell edit, such as adding or removing a unit, a row
 * or a sheet. Hubble's undo puts it back by asking the module.
 */
export interface SpreadsheetHistoryChange {
  /**
   * Puts the change back: removes the unit that was added, or adds back,
   * where it was, the unit that was removed with everything it held. Apply it
   * at once and save it as any other edit. If that save fails, roll it back
   * and pass `attempt` to `forget`, so the step can be undone again.
   */
  undo(attempt: object): void;
  /** Makes the change again, as `undo` describes. */
  redo(attempt: object): void;
}
/** Undo and redo that Hubble keeps for a grid mounted with `history`. */
export interface SpreadsheetHistory {
  state(): { undo: boolean; redo: boolean };
  undo(): void;
  redo(): void;
  /**
   * Remembers an edit the module makes itself, such as typed text, as one
   * step. Call it just before applying the edit, while getCell still returns
   * the old values. Returns a token for `forget`.
   */
  record(edits: readonly SpreadsheetEdit[]): object;
  /**
   * Remembers a change the module makes that is not a cell edit, such as
   * adding or removing a unit, as one step in the same history. Returns a
   * token for `forget`.
   */
  recordChange(change: SpreadsheetHistoryChange): object;
  /**
   * A save failed: pass the batch onEdit received, a `record` or
   * `recordChange` token, or the `attempt` a change's undo or redo was given.
   * A gesture's step is dropped, so Undo never brings back a value that never
   * held; a refused undo or redo goes back where it was.
   */
  forget(batchOrToken: object): void;
  clear(): void;
}
export interface SpreadsheetControlsOptions {
  readonly root: HTMLElement;
  /** Scroll viewport for chrome clipping. */
  readonly viewport?: HTMLElement;
  /** Enables modifier selection and Delete/Backspace batches. */
  readonly extendedEditing?: boolean;
  readonly workbookEditing?: boolean;
  translateFormula?(source: string, columns: number, rows: number): string;
  formulaPoint?(
    address: SpreadsheetAddress,
  ): { row: number; column: number; sheetId: string } | undefined;
  readonly colorFavorites?: {
    get(): readonly string[];
    set(colors: readonly string[]): void;
  };
  onHistory?(direction: "undo" | "redo"): void;
  /**
   * Lets Hubble keep undo and redo for this grid. Requires
   * module-spreadsheet-history-v1. Each paste, fill, clear, cut, choice,
   * toggle, colour and recorded edit is one step, up to `limit` (200). Undo
   * and Redo send the cells back through onEdit with source `undo` or `redo`,
   * and leave a cell that changed since this grid's step (in another window,
   * or by the module) as it is. When set, onHistory is not called.
   */
  readonly history?: boolean | { readonly limit?: number };
  onHistoryChange?(state: { undo: boolean; redo: boolean }): void;
  /**
   * The cells Undo or Redo left as they are because they changed since.
   * Without it, Hubble says so through onError.
   */
  onHistoryLeft?(
    cells: readonly SpreadsheetAddress[],
    direction: "undo" | "redo",
  ): void;
  onSelection?(address: SpreadsheetAddress | undefined): void;
  onReferencePick?(address: SpreadsheetAddress): boolean;
  /** Visible rows and columns in display order; IDs must be unique and stable. */
  getRows(): readonly string[];
  getColumns(): readonly SpreadsheetColumn[];
  /** Return null when the cell is unavailable. */
  getCell(address: SpreadsheetAddress): SpreadsheetCell | null;
  /** Called synchronously once per gesture. The module owns draft, validation and saves. */
  onEdit(batch: SpreadsheetEditBatch): void;
  onError?(error: Error): void;
}
export interface SpreadsheetControls {
  refresh(): void;
  select(
    anchor: SpreadsheetAddress,
    end?: SpreadsheetAddress,
    options?: { focus?: boolean },
  ): void;
  /** Clear all editable selected cells in one batch on extended-editing hosts. */
  clear?(): void;
  move?(columns: number, rows: number): boolean;
  /** Present when the grid was mounted with `history`. */
  readonly history?: SpreadsheetHistory;
  dispose(): void;
}
/** Matrix context-menu chrome; commands and their effects remain module-owned. */
export type SpreadsheetMenuItem =
  | { readonly separator: true }
  | {
      readonly id: string;
      readonly label: string;
      readonly disabled?: boolean;
      readonly danger?: boolean;
      readonly icon?: "add" | "delete";
      readonly items?: readonly SpreadsheetMenuItem[];
      readonly run?: () => void;
    };
export interface SpreadsheetMenuRequest {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly issue?: string;
  readonly items: readonly SpreadsheetMenuItem[];
}
export interface SpreadsheetMenuOptions {
  /** Return keyboard focus here when the menu closes. */
  readonly root: HTMLElement;
  onError?(error: Error): void;
}
export interface SpreadsheetMenu {
  open(request: SpreadsheetMenuRequest): void;
  close(): void;
  dispose(): void;
}
export interface SpreadsheetReorderItem {
  readonly id: string;
  readonly label: string;
  readonly axis: "row" | "column";
  /** Items can move only among peers in the same axis and scope. */
  readonly scope?: string;
  readonly handle: HTMLElement;
  /** Visible cells/header fragments, used for the floating preview. */
  readonly elements: readonly HTMLElement[];
}
export interface SpreadsheetMove {
  readonly axis: "row" | "column";
  readonly scope?: string;
  readonly ids: readonly string[];
  /** Stable peer ID; null means after the last peer. */
  readonly beforeId: string | null;
}
export interface SpreadsheetReorderOptions {
  readonly root: HTMLElement;
  /** Visible items in display order, with stable IDs unique within each scope. */
  getItems(): readonly SpreadsheetReorderItem[];
  /** Optional full-row selection. A column gesture moves one column/group. */
  getSelectedRows?(): readonly string[];
  onSelect?(item: SpreadsheetReorderItem, extend: boolean): void;
  /** One synchronous callback per completed move. Update before saving. */
  onMove(move: SpreadsheetMove): void;
  onError?(error: Error): void;
}
export interface SpreadsheetReorderControls {
  /** Rebind handles after a module update. Changed geometry cancels an active drag. */
  refresh(): void;
  dispose(): void;
}

/** Load the matching host runtime from inside the opaque Hubble custom page. */
export async function mountSpreadsheetControls(
  options: SpreadsheetControlsOptions,
): Promise<SpreadsheetControls> {
  const runtime = await loadRuntime();
  if (typeof runtime.mount !== "function") {
    throw new Error(`Invalid ${MODULE_SPREADSHEET_CONTROLS_FEATURE} runtime`);
  }
  if (options.extendedEditing && typeof runtime.mountResize !== "function")
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE}`,
    );
  if (options.workbookEditing) requireWorkbookTools(runtime.mountToolbar);
  if (options.history && runtime.historySupported !== true)
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_HISTORY_FEATURE}`,
    );
  return runtime.mount(options);
}

/** Optional Matrix-style expandable header for a module-defined field group. */
export async function mountSpreadsheetColumnGroup(
  options: SpreadsheetColumnGroupOptions,
): Promise<SpreadsheetColumnGroupControls> {
  const runtime = await loadRuntime();
  if (typeof runtime.mountColumnGroup !== "function") {
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE}`,
    );
  }
  return runtime.mountColumnGroup(options);
}

function requireCustomPage() {
  if (
    window.parent === window ||
    !/^\/api\/module-pages\/[A-Za-z0-9_-]{43}\/ui\//u.test(location.pathname)
  ) {
    throw new Error("Spreadsheet controls require a Hubble custom page");
  }
}

async function loadRuntime() {
  requireCustomPage();
  const url = new URL("/api/module-controls/spreadsheet-v1.js", location.href)
    .href;
  let runtime: {
    mount?: (input: SpreadsheetControlsOptions) => SpreadsheetControls;
    mountColumnGroup?: (
      input: SpreadsheetColumnGroupOptions,
    ) => SpreadsheetColumnGroupControls;
    mountColumnEditor?: (
      options: SpreadsheetColumnEditorOptions,
    ) => SpreadsheetResizeControls;
    mountToolbar?: (options: SpreadsheetToolbarOptions) => SpreadsheetToolbar;
    mountColumnSearch?: (
      options: SpreadsheetColumnSearchOptions,
    ) => SpreadsheetColumnSearchControls;
    mountSearch?: (
      options: SpreadsheetSearchOptions,
    ) => SpreadsheetSearchControls;
    spreadsheetColumnsOnScreen?: (
      items: readonly SpreadsheetColumnEditorItem[],
    ) => string[];
    mountSheets?: (
      options: SpreadsheetSheetsOptions,
    ) => SpreadsheetResizeControls;
    mountViewport?: (
      options: SpreadsheetViewportOptions,
    ) => SpreadsheetResizeControls;
    createTransfer?: (root: HTMLElement) => SpreadsheetWorkbookTransfer;
    mountResize?: (
      input: SpreadsheetResizeOptions,
    ) => SpreadsheetResizeControls;
    createContextMenu?: (input: SpreadsheetMenuOptions) => SpreadsheetMenu;
    mountReorder?: (
      input: SpreadsheetReorderOptions,
    ) => SpreadsheetReorderControls;
    historySupported?: boolean;
  };
  try {
    runtime = await import(/* @vite-ignore */ url);
  } catch (cause) {
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_CONTROLS_FEATURE}`,
      { cause },
    );
  }
  return runtime;
}

/** Matrix menu appearance and keyboard behavior with module-owned commands. */
export async function createSpreadsheetContextMenu(
  options: SpreadsheetMenuOptions,
): Promise<SpreadsheetMenu> {
  const runtime = await loadRuntime();
  if (typeof runtime.createContextMenu !== "function")
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_LAYOUT_FEATURE}`,
    );
  return runtime.createContextMenu(options);
}

/** Optional Matrix hold-to-lift column/group and row dragging for custom layouts. */
export async function mountSpreadsheetReorder(
  options: SpreadsheetReorderOptions,
): Promise<SpreadsheetReorderControls> {
  const runtime = await loadRuntime();
  if (typeof runtime.mountReorder !== "function")
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_LAYOUT_FEATURE}`,
    );
  return runtime.mountReorder(options);
}

export interface SpreadsheetResizeItem {
  readonly id: string;
  readonly label: string;
  readonly axis: "row" | "column";
  readonly header: HTMLElement;
  readonly size: number;
  readonly min: number;
  readonly max: number;
}

export interface SpreadsheetResizeOptions {
  readonly root: HTMLElement;
  /** Scroll viewport, if the grid can extend outside its visible container. */
  readonly viewport?: HTMLElement;
  getItems(): readonly SpreadsheetResizeItem[];
  getScale?(): number;
  /** Update the visible size immediately. Persistence is module-owned. */
  onResize(item: SpreadsheetResizeItem, size: number): void;
}

export interface SpreadsheetResizeControls {
  refresh(): void;
  dispose(): void;
}

export async function mountSpreadsheetResize(
  options: SpreadsheetResizeOptions,
): Promise<SpreadsheetResizeControls> {
  const runtime = await loadRuntime();
  if (typeof runtime.mountResize !== "function")
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE}`,
    );
  return runtime.mountResize(options);
}

export interface SpreadsheetWorkbookSnapshot {
  rows: ModuleTableRow[];
  view: ModuleTableViewState;
}
type SaveWorkbook = (
  next: SpreadsheetWorkbookSnapshot,
  before: SpreadsheetWorkbookSnapshot,
) => Promise<
  SpreadsheetWorkbookSnapshot & {
    normalization?: {
      before: SpreadsheetWorkbookSnapshot;
      after: SpreadsheetWorkbookSnapshot;
    };
  }
>;
/** Optimistic, ordered editing session shared with the native workbook. */
export interface SpreadsheetWorkbookSession {
  readonly current: SpreadsheetWorkbookSnapshot;
  readonly pendingCount: number;
  readonly undo: readonly unknown[];
  readonly redo: readonly unknown[];
  observe(snapshot: SpreadsheetWorkbookSnapshot): void;
  subscribe(listener: () => void): () => void;
  edit(
    next: SpreadsheetWorkbookSnapshot,
    save: SaveWorkbook,
    fail: (error: unknown) => void,
    remember?: boolean,
  ): void;
  history(
    forward: boolean,
    save: SaveWorkbook,
    fail: (error: unknown) => void,
  ): void;
  cancel(): void;
}
export interface SpreadsheetWorkbookTools {
  createSession(
    snapshot: SpreadsheetWorkbookSnapshot,
  ): SpreadsheetWorkbookSession;
  createRow(index: number): ModuleTableRow;
  duplicateRow(row: ModuleTableRow): ModuleTableRow;
  calculate(snapshot: SpreadsheetWorkbookSnapshot): Promise<{
    rows: ModuleTableRow[];
    errors: Record<string, Record<string, string>>;
  }>;
  translateFormula(source: string, columns: number, rows: number): string;
  remapFormulas(
    before: SpreadsheetWorkbookSnapshot,
    after: SpreadsheetWorkbookSnapshot,
  ): ModuleTableRow[];
  coordinate(
    snapshot: SpreadsheetWorkbookSnapshot,
    address: SpreadsheetAddress,
  ): { row: number; column: number; sheetId: string } | undefined;
  reference(
    snapshot: SpreadsheetWorkbookSnapshot,
    address: SpreadsheetAddress,
    from?: SpreadsheetAddress,
  ): string;
  copyWorkbook(snapshot: SpreadsheetWorkbookSnapshot): string;
  pasteWorkbook(text: string): SpreadsheetWorkbookSnapshot;
  rowsForSheet(
    snapshot: SpreadsheetWorkbookSnapshot,
    id: string,
  ): ModuleTableRow[];
  removeSheet(
    snapshot: SpreadsheetWorkbookSnapshot,
    id: string,
  ): ModuleTableViewState;
  resetChoices(
    before: ModuleTableRow[],
    after: ModuleTableRow[],
    edits: readonly SpreadsheetAddress[],
  ): ModuleTableRow[];
}

export interface SpreadsheetToolbarOptions {
  readonly root: HTMLElement;
  /** Supply both getSource and onSource to show the formula bar. */
  getSource?():
    | {
        id: string;
        reference: string;
        value: string;
        resolved: string;
        editable: boolean;
      }
    | undefined;
  /** Supply both getHistory and onHistory to show the history buttons. */
  getHistory?(): { undo: boolean; redo: boolean };
  onHistory?(direction: "undo" | "redo"): void;
  onSource?(value: string): boolean | void;
  onFocusGrid?(): void;
  /** Standalone Matrix text-size controls. Requires module-spreadsheet-text-size-v1. */
  readonly textSize?: { get(): number; onChange(value: number): void };
  readonly layout?: {
    get(): { textSize: number; frozenColumns: number };
    onChange(update: { textSize?: number; frozenColumns?: number }): void;
  };
}
export interface SpreadsheetToolbar extends SpreadsheetResizeControls {
  pickReference(reference: string): boolean;
}
export interface SpreadsheetColumnEditorField {
  readonly id: string;
  readonly label: string;
  /** With column sections, the Show tick alone: collapsing never changes it. */
  readonly visible: boolean;
  /** Column sections: the When collapsed tick, on screen while its section is collapsed. */
  readonly shownWhenCollapsed?: boolean;
}
export type SpreadsheetColumnEditorItem =
  | SpreadsheetColumnEditorField
  | {
      readonly id: string;
      readonly label: string;
      /** Optional independent group toggle. Requires column-visibility-v1. Not with column sections. */
      readonly visible?: boolean;
      /** Column sections: the section is expanded on the page. Requires column-sections-v1. */
      readonly expanded?: boolean;
      readonly fields: readonly SpreadsheetColumnEditorField[];
    };

/**
 * The one rule for column sections: a column is on screen when its Show is ticked and its
 * section is expanded or it is ticked When collapsed. Hubble's editor uses the same rule.
 */
export function spreadsheetColumnsOnScreen(
  items: readonly SpreadsheetColumnEditorItem[],
): string[] {
  return items.flatMap((item) =>
    "fields" in item
      ? item.fields
          .filter(
            (field) =>
              field.visible &&
              (item.expanded !== false || field.shownWhenCollapsed === true),
          )
          .map((field) => field.id)
      : item.visible
        ? [item.id]
        : [],
  );
}

/** Whether this Hubble's Columns editor has column sections. Older hosts show the plain editor. */
export async function spreadsheetColumnSectionsSupported(): Promise<boolean> {
  const runtime = await loadRuntime();
  return typeof runtime.spreadsheetColumnsOnScreen === "function";
}
export interface SpreadsheetColumnEditorOptions {
  readonly root: HTMLElement;
  /** Include hidden fields and use unique, stable IDs for fields and groups. */
  getItems(): readonly SpreadsheetColumnEditorItem[];
  onVisibilityChange(id: string, visible: boolean): void;
  /** One batch per drag; apply immediately and save once. Requires column-paint-v1. */
  onVisibilityChanges?(
    changes: readonly { id: string; visible: boolean }[],
  ): void;
  /** Move a field or group before a sibling. Null means the end of its list. */
  onMove?(id: string, beforeId: string | null): void;
  /** Column sections: the Expanded / Collapsed word on a section's row. Requires column-sections-v1. */
  onExpandedChange?(groupId: string, expanded: boolean): void;
  /** Column sections: When collapsed ticks; a section's tick-all arrives as one batch. */
  onShownWhenCollapsedChanges?(
    changes: readonly {
      readonly id: string;
      readonly shownWhenCollapsed: boolean;
    }[],
  ): void;
}
/** A search field for the page's own toolbar. Requires column-search-v1. */
export interface SpreadsheetColumnSearchOptions {
  /** An empty slot in the page's toolbar. The field keeps one width. */
  readonly root: HTMLElement;
  /** The same items as the Columns menu: every column the page has, by stable ID. */
  getItems(): readonly SpreadsheetColumnEditorItem[];
  /**
   * Called as the operator types, again after refresh() when the items change what
   * the search matches, and with null once it is cleared. Show only the matching
   * columns and keep the ones that name each row. It is a view: never save it.
   */
  onSearch(search: SpreadsheetColumnSearch | null): void;
  /** Enter, Down Arrow, or Escape in an empty field hand the keyboard back to the sheet. */
  onFocusGrid?(): void;
}
export interface SpreadsheetColumnSearch {
  /** What the operator typed, trimmed. */
  readonly query: string;
  /** Columns whose own name, or whose section's name, has every typed word. In item order. */
  readonly fieldIds: readonly string[];
  /** Sections whose name matches or that hold a matching column. */
  readonly groupIds: readonly string[];
}
export interface SpreadsheetColumnSearchControls {
  /** Call after the items change, such as on another tab. */
  refresh(): void;
  /** Show every column again. */
  clear(): void;
  /** Put the cursor in the field, as Command-F does. */
  focus(): void;
  dispose(): void;
}
/** What the search field does: mark matching cells, keep matching rows, or keep matching columns. */
export type SpreadsheetSearchMode = "find" | "rows" | "columns";
/**
 * The Button Matrix's search field in a module page (module-spreadsheet-search-v1). The operator
 * picks what it does. Find marks the cells whose text has every typed word and steps through
 * them; Rows keeps only the rows holding one; Columns keeps only the columns whose names have
 * them, as the column search does. Hubble searches, counts and marks the cells; the page hides
 * rows and columns and selects. It is a view: never save it.
 */
export interface SpreadsheetSearchOptions {
  /** An empty slot in the page's own toolbar or header. */
  readonly root: HTMLElement;
  /** The choice the field starts on. Defaults to "find". */
  readonly mode?: SpreadsheetSearchMode;
  /** Columns: the same items as the Columns menu, every column the page has, by stable ID. */
  getItems(): readonly SpreadsheetColumnEditorItem[];
  /**
   * Columns: called as the operator types, again after refresh() when the items change what the
   * search matches, and with null once it is cleared or another choice is picked. Show only the
   * matching columns and keep the ones that name each row, exactly as for onSearch.
   */
  onColumns(search: SpreadsheetColumnSearch | null): void;
  /** Find and Rows: the element holding cells with data-hubble-row and data-hubble-column. */
  grid(): HTMLElement | null;
  /** Find and Rows: every row that can show, in display order, whatever Rows hides now. */
  getRows(): readonly string[];
  /**
   * Find and Rows: the columns the page shows when the search hides none, in display order. Their
   * cells are searched. The page's own Show ticks and collapsed sections still apply.
   */
  getColumns(): readonly string[];
  /** What the cell shows. Return an empty string for cells that should not be searched. */
  getText(address: SpreadsheetAddress): string;
  /**
   * Where a cell sits in the grid when its data-hubble-row and data-hubble-column differ from
   * its address, as when a layout draws columns as rows.
   */
  getCellAttributes?(address: SpreadsheetAddress): SpreadsheetAddress;
  /** Rows that stay together when one of them matches. */
  getRowGroup?(rowId: string): string;
  /**
   * Rows: called with the rows to show, in display order, and with null to show every row again.
   * No row matched gives an empty list. Rows are worked out as the operator types and not when
   * data changes, so a row being edited never vanishes under the editor.
   */
  onRows(rowIds: readonly string[] | null): void;
  /** Find and Rows: select and scroll to the match the search stands on. */
  onSelect?(address: SpreadsheetAddress): void;
  /** Return in Columns, or Escape: the sheet takes the keyboard back. */
  onFocusGrid?(): void;
  onError?(error: Error): void;
}
export interface SpreadsheetSearchControls {
  /** The cells or the items changed: search again. Rows keeps the rows it shows. */
  refresh(): void;
  /** Bring back a row Rows hides, for example after Undo changed one of its cells. */
  reveal(address: SpreadsheetAddress): void;
  /** Put the cursor in the field, as Command-F does. */
  focus(): void;
  /** Clear the words; everything shows again. The choice stays. */
  clear(): void;
  /** Where the search stands, for a page's own checks. */
  state(): {
    query: string;
    mode: SpreadsheetSearchMode;
    matches: number;
    rows: number | null;
    columns: number | null;
  };
  dispose(): void;
}
export interface SpreadsheetSheetsOptions {
  readonly root: HTMLElement;
  getState(): {
    sheets: { id: string; name: string }[];
    activeSheetId: string;
    counts: ReadonlyMap<string, number>;
    canMoveSelection?: boolean;
  };
  onSelect(id: string): void;
  onCreate(name: string): void;
  onRename(id: string, name: string): void;
  onRemove(id: string): void;
  onReorder(id: string, beforeId: string | null): void;
  onMoveSelection?(id: string): void;
}
export interface SpreadsheetViewportOptions {
  readonly root: HTMLElement;
  readonly viewport: HTMLElement;
  getFrozen?(): readonly { element: HTMLElement; left: number }[];
  onZoom?(ratio: number): void;
}
export interface SpreadsheetWorkbookTransfer {
  copy(text: string): void;
  paste(write: (text: string) => void): void;
  dispose(): void;
}
function requireWorkbookTools<T>(factory: T | undefined): T {
  if (typeof factory !== "function")
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_WORKBOOK_TOOLS_FEATURE}`,
    );
  return factory;
}
export async function createSpreadsheetWorkbookTools(table: ModulePageTable) {
  requireCustomPage();
  const url = new URL(
    "/api/module-controls/workbook-tools-v1.js",
    location.href,
  ).href;
  let runtime: {
    workbookTools?: (input: ModulePageTable) => SpreadsheetWorkbookTools;
  };
  try {
    runtime = await import(/* @vite-ignore */ url);
  } catch (cause) {
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_WORKBOOK_TOOLS_FEATURE}`,
      { cause },
    );
  }
  return requireWorkbookTools(runtime.workbookTools)(table);
}
export async function mountSpreadsheetToolbar(
  options: SpreadsheetToolbarOptions,
) {
  return requireWorkbookTools((await loadRuntime()).mountToolbar)(options);
}
export async function mountSpreadsheetColumnEditor(
  options: SpreadsheetColumnEditorOptions,
) {
  const { mountColumnEditor } = await loadRuntime();
  if (!mountColumnEditor)
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_COLUMN_EDITOR_FEATURE}`,
    );
  return mountColumnEditor(options);
}
/** The shared column search field in a module-chosen toolbar slot. */
export async function mountSpreadsheetColumnSearch(
  options: SpreadsheetColumnSearchOptions,
): Promise<SpreadsheetColumnSearchControls> {
  const { mountColumnSearch } = await loadRuntime();
  if (!mountColumnSearch)
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_COLUMN_SEARCH_FEATURE}`,
    );
  return mountColumnSearch(options);
}
/** The search field with Find, Rows and Columns, in a module-chosen slot. */
export async function mountSpreadsheetSearch(
  options: SpreadsheetSearchOptions,
): Promise<SpreadsheetSearchControls> {
  const { mountSearch } = await loadRuntime();
  if (!mountSearch)
    throw new Error(
      `Host does not supply ${MODULE_SPREADSHEET_SEARCH_FEATURE}`,
    );
  return mountSearch(options);
}
export async function mountSpreadsheetSheets(
  options: SpreadsheetSheetsOptions,
) {
  return requireWorkbookTools((await loadRuntime()).mountSheets)(options);
}
export async function mountSpreadsheetViewport(
  options: SpreadsheetViewportOptions,
) {
  return requireWorkbookTools((await loadRuntime()).mountViewport)(options);
}
export async function createSpreadsheetWorkbookTransfer(root: HTMLElement) {
  return requireWorkbookTools((await loadRuntime()).createTransfer)(root);
}
