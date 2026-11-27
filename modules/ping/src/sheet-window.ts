import type { ModuleWindowPart } from "@hubble/module-sdk/frontend";
import { newDevice, openSheetId, setDeviceCount, sheetRows, sheetsOf, type DeviceRow, type PingDocument, type Sheet } from "./model.js";

/**
 * Ping's sheets in windows of their own.
 *
 * Right-click Ping in HubDash's sidebar, and Open in its own window › offers the whole module and
 * each sheet. The worker publishes the sheets as `windowParts` (the manifest names that value), and
 * a sheet's window gets the sheet's ID as `page.view`. That window shows the one sheet, its devices
 * and a timeline of its own, whichever sheet the module's whole page has open. It never saves which
 * sheet is open, so the whole page opens where the operator left it.
 */

/**
 * The most parts Hubble lists for one page: the SDK's MODULE_WINDOW_PARTS_LIMIT, which a test
 * compares. It is written out because the worker imports this file, and importing the SDK's
 * frontend entry there would bundle a second copy of zod into module.mjs.
 */
export const WINDOW_PARTS_LIMIT = 24;

/** A sheet's name as a window title: one line of up to 80 characters. */
export function partTitle(name: string): string {
  const line = name
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80)
    .trimEnd();
  return line || "Sheet";
}

/**
 * The parts the sidebar lists: each sheet in order, by its ID, which stays the same through a
 * rename, a move and a restart. Hubble lists up to 24; any further sheets open in the whole page.
 */
export function windowParts(document: PingDocument): ModuleWindowPart[] {
  return sheetsOf(document)
    .slice(0, WINDOW_PARTS_LIMIT)
    .map((sheet) => ({ view: sheet.id, title: partTitle(sheet.name) }));
}

/** The device list one copy of the page holds (its DraftStore). */
interface Holder {
  readonly document: PingDocument;
  subscribe(listener: () => void): () => unknown;
}
/** The parts of Hubble's page client a sheet's window uses. */
export interface WindowPage {
  /** The sheet's ID in a sheet's own window; null in the whole page. */
  readonly view: string | null;
  setWindowTitle(title: string): Promise<void>;
}

/**
 * The sheet one copy of the page shows. The whole page shows the open sheet, which every copy of
 * the whole page shares. A sheet's window shows its own sheet, and nothing once that sheet is
 * removed; it shows it again if the sheet is put back, since an Undo brings back the same ID.
 */
export function sheetWindow(page: WindowPage, list: Holder) {
  const own = page.view;
  const sheet = (): Sheet | undefined => {
    const id = own ?? openSheetId(list.document);
    return sheetsOf(list.document).find((item) => item.id === id);
  };
  let titled: string | undefined;
  /** A sheet's window is called after its sheet, renamed in any window. */
  const retitle = () => {
    const shown = own === null ? undefined : sheet();
    if (!shown) return;
    const title = partTitle(shown.name);
    if (title === titled) return;
    titled = title;
    void page.setWindowTitle(title).catch(() => undefined);
  };
  const stop = own === null ? () => undefined : list.subscribe(retitle);
  // At once too: the sheet may have been renamed while HubDash had the window closed.
  retitle();
  return {
    /** Whether this is a sheet's own window. */
    own: own !== null,
    sheet,
    /** Whether this window's sheet has been removed. */
    gone: () => own !== null && sheet() === undefined,
    /** The devices on the sheet shown, in list order. */
    rows(): DeviceRow[] {
      const shown = sheet();
      return shown ? sheetRows(list.document, shown.id) : [];
    },
    /** A new device for the sheet shown. */
    newDevice(id: string): DeviceRow | undefined {
      const shown = sheet();
      return shown ? newDevice(list.document, id, shown.id) : undefined;
    },
    /** What the Devices box asks for: that many devices on the sheet shown. */
    count(count: number, newId: () => string) {
      const shown = sheet();
      return shown ? setDeviceCount(list.document, count, newId, shown.id) : null;
    },
    dispose() {
      stop();
    },
  };
}
