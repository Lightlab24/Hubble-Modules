import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PLACE_KEY_LIMIT, readPlace, type Place } from "./place.js";

/** The most windows remembered; the one left longest ago goes first. */
const KEPT = 64;

interface Saved {
  place: Place;
  at: number;
}

/**
 * Where each window of the Ping page was last left (see place.ts), kept in the module's runtime
 * folder on the computer Hubble runs on. That folder is never in a workspace export. A sheet's own
 * window is remembered by its sheet; one never left anywhere opens with the whole page's time and
 * scale. Without the folder it is kept for this run only.
 */
export function placeStore(directory: () => string | undefined, now: () => number = Date.now) {
  let places: Map<string, Saved> | undefined;
  const file = () => {
    const folder = directory();
    return folder ? path.join(folder, "page-view.json") : null;
  };
  function load(): Map<string, Saved> {
    if (places) return places;
    places = new Map();
    const target = file();
    if (!target) return places;
    try {
      const saved = JSON.parse(readFileSync(target, "utf8")) as { places?: Record<string, { place?: unknown; at?: unknown }> };
      for (const [key, entry] of Object.entries(saved.places ?? {})) {
        const place = readPlace(entry?.place);
        if (place && key.length <= PLACE_KEY_LIMIT) places.set(key, { place, at: Number(entry?.at) || 0 });
      }
    } catch {
      /* Nothing left anywhere yet, or a file that can't be read: start again. */
    }
    return places;
  }
  return {
    read(key: string): Place | null {
      const all = load();
      const own = all.get(key)?.place;
      if (own) return own;
      // A sheet's window opens with the time and scale the whole page was left on.
      const whole = key ? all.get("")?.place : undefined;
      if (!whole) return null;
      const { sheetId: _sheet, ...rest } = whole;
      return rest;
    },
    write(key: string, value: unknown): void {
      const place = readPlace(value);
      if (typeof key !== "string" || key.length > PLACE_KEY_LIMIT || !place) throw Error("That isn't a place on the Ping page.");
      const all = load();
      all.delete(key);
      all.set(key, { place, at: now() });
      while (all.size > KEPT) {
        const oldest = [...all.entries()].sort((a, b) => a[1].at - b[1].at)[0]![0];
        all.delete(oldest);
      }
      const target = file();
      if (!target) return;
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, places: Object.fromEntries(all) }), { mode: 0o600 });
      renameSync(temporary, target);
    },
  };
}
