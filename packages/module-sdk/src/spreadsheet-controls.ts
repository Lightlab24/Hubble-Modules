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
        | readonly SpreadsheetChoice[]
        | Promise<readonly SpreadsheetChoice[]>);
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
  readonly source:
    | "choice"
    | "paste"
    | "fill"
    | "clear"
    | "toggle"
    | "cut"
    | "color";
  readonly edits: readonly SpreadsheetEdit[];
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
  readonly visible: boolean;
}
export type SpreadsheetColumnEditorItem =
  | SpreadsheetColumnEditorField
  | {
      readonly id: string;
      readonly label: string;
      /** Optional independent group toggle. Requires column-visibility-v1. */
      readonly visible?: boolean;
      readonly fields: readonly SpreadsheetColumnEditorField[];
    };
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
