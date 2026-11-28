import type { ModuleWindowPart } from "@hubble/module-sdk/frontend";
import { newDevice, setDeviceCount, sheetRows, sheetsOf, type DeviceRow, type PingDocument, type Sheet } from "./model.js";

/**
 * Ping's sheets in windows of their own.
 *
 * Right-click Ping in HubDash's sidebar, and Open in its own window › offers the whole module and
 * each sheet. The worker publishes the sheets as `windowParts` (the manifest names that value), and
 * a sheet's window gets the sheet's ID as `page.view`. That window shows the one sheet, its devices
 * and a timeline of its own, whichever sheet the module's whole page has open.
 *
 * The whole page has sheet tabs, and the sheet open in it is that window's own: opening a sheet in
 * one window never moves another (place.ts).
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

/** The most sheets a window remembers having opened, to go back to. */
const EARLIER = 32;

/**
 * The sheet one copy of the page shows. A sheet's window shows its own sheet, and nothing once that
 * sheet is removed; it shows it again if the sheet is put back, since an Undo brings back the same ID.
 *
 * The whole page shows the sheet open in this window, starting with `opened`. If that sheet is
 * removed, here or in another window, this window goes back to the sheet it had open before (as
 * after an Undo of adding a sheet), or else the one beside it, or else the first; and if the sheet
 * comes back before another is opened here (an Undo of removing it), it opens again.
 */
export function sheetWindow(page: WindowPage, list: Holder, opened?: string) {
  const own = page.view;
  const ids = () => sheetsOf(list.document).map((item) => item.id);
  let open = opened !== undefined && ids().includes(opened) ? opened : ids()[0]!;
  /** Sheets opened here before the open one, the latest last. */
  let earlier: string[] = [];
  /** The sheet that was open here when it was removed, until another is opened. */
  let lost: string | undefined;
  /** The sheets in order, as last seen here. */
  let known = ids();
  /** Opens the right sheet after the sheets changed: worked out on reading, so it is never a step behind. */
  function settle() {
    const now = ids();
    // Back again after it was seen gone: just before this window's own removal of it saves, it is still here.
    if (lost !== undefined && now.includes(lost) && !known.includes(lost)) {
      open = lost;
      lost = undefined;
    } else if (!now.includes(open)) {
      lost = open;
      open = [...earlier].reverse().find((id) => now.includes(id)) ?? beside(open, known, now) ?? now[0]!;
    }
    earlier = earlier.filter((id) => now.includes(id) && id !== open);
    known = now;
    return open;
  }
  /** The sheet after `id` in `order`, or else the one before it, that is still there. */
  function beside(id: string, order: readonly string[], now: readonly string[]) {
    const index = order.indexOf(id);
    if (index < 0) return undefined;
    return order.slice(index + 1).find((item) => now.includes(item)) ?? order.slice(0, index).reverse().find((item) => now.includes(item));
  }
  const sheet = (): Sheet | undefined => {
    const id = own ?? settle();
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
    /** The sheet open in the whole page here. */
    openId: () => own ?? settle(),
    /** Opens a sheet in the whole page here; false if it is open already, is gone, or this is a sheet's window. */
    open(id: string): boolean {
      if (own !== null || !ids().includes(id) || id === settle()) return false;
      earlier = [...earlier.filter((item) => item !== id), open].slice(-EARLIER);
      open = id;
      lost = undefined;
      return true;
    },
    /**
     * Called just before this window removes a sheet: if it is the open one, the one beside it opens,
     * and an Undo that brings the sheet back opens it again.
     */
    leave(id: string) {
      if (own !== null || id !== settle()) return;
      const order = ids();
      const next = beside(id, order, order.filter((item) => item !== id));
      if (next === undefined) return;
      open = next;
      lost = id;
    },
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
