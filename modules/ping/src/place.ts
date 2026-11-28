import { SCALE_MAX_MS, SCALE_MIN_MS, SPANS, type PingDocument, type SpanId } from "./model.js";

/**
 * Where one window of the Ping page is: the sheet it has open, how much time it shows (Show last)
 * and the timeline's scale. Each window has its own, so two windows showing Ping share the devices,
 * settings, sheets and layout but never move each other, as Cyanview's windows don't (asked for
 * Nov 28, 2026: "i wanted the data to match but they could be doing different things").
 *
 * It is not workspace data. The worker remembers where the page was last left on this computer
 * (place-store.ts), and a page reads that only as it opens. Until 0.2.1 the three were saved in the
 * shared ping-plan as view.sheetId, view.span and view.scaleMs, so a change in one window moved
 * every other; a list saved then still says where a page opens until it has been left somewhere.
 */
export interface Place {
  /** The sheet open in the whole page. Absent, or a sheet that is gone, is the first sheet. A sheet's own window has none. */
  sheetId?: string;
  span: SpanId;
  /** The answer time at the top of the timeline, in ms. Absent is Auto: it fits the tallest bar on show. */
  scaleMs?: number;
}

/** Which window a place is for: "" for the whole page, a sheet's ID for that sheet's own window (`page.view`). */
export const PLACE_KEY_LIMIT = 128;

/** A place, with anything in it that isn't one left out; null if it doesn't say what time to show. */
export function readPlace(value: unknown): Place | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { sheetId, span, scaleMs } = value as Record<string, unknown>;
  const known = SPANS.find((item) => item.id === span);
  if (!known) return null;
  return {
    span: known.id,
    ...(typeof sheetId === "string" && sheetId && sheetId.length <= 96 ? { sheetId } : {}),
    ...(typeof scaleMs === "number" && Number.isFinite(scaleMs) && scaleMs >= SCALE_MIN_MS && scaleMs <= SCALE_MAX_MS ? { scaleMs } : {}),
  };
}

/** Where a window opens: where the page was last left, or else where a list saved before 0.2.1 said. */
export function startingPlace(remembered: Place | null, document: PingDocument): Place {
  if (remembered) return { ...remembered };
  const { sheetId, span, scaleMs } = document.view;
  return readPlace({ sheetId, span, scaleMs }) ?? { span: "10m" };
}
