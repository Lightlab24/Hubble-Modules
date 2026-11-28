import { ModuleFrontendValueSchema, type ModuleFrontendValue } from "@hubble/module-sdk/frontend";
import { DraftStore, followSaved, type SaveReceipt } from "./draft-store.js";
import type { Mutation, PingDocument, SpanId } from "./model.js";
import { readPlace, startingPlace, type Place } from "./place.js";

/** The parts of Hubble's page client the device list uses. */
export interface PageClient {
  call(commandId: string, value?: ModuleFrontendValue): Promise<ModuleFrontendValue>;
  subscribe(listener: (state: ModuleFrontendValue) => void): () => void;
}

/** The revision in a state the worker published, if it has one. */
export function revisionIn(state: unknown): unknown {
  const values = state && typeof state === "object" && !Array.isArray(state) ? (state as { values?: unknown }).values : undefined;
  return values && typeof values === "object" && !Array.isArray(values) ? (values as { revision?: unknown }).revision : undefined;
}

/**
 * Reads the device list and keeps it: edits show at once and save in order, and every open copy
 * of the page, in any HubDash window, follows what the others save. Hubble hands the page the
 * worker's state, which carries the list's revision; the page also passes on the revision from
 * each ping update with `follow.saw`, which is often sooner.
 */
export async function openDeviceList(client: PageClient) {
  const initial = (await client.call("snapshot")) as unknown as SaveReceipt;
  const store = new DraftStore(initial, async (operation: Mutation) => (await client.call("save", ModuleFrontendValueSchema.parse({ operation }))) as unknown as SaveReceipt);
  const follow = followSaved(store, async () => (await client.call("snapshot")) as unknown as SaveReceipt);
  const stop = client.subscribe((state) => follow.saw(revisionIn(state)));
  return {
    store,
    follow,
    close() {
      follow.dispose();
      stop();
    },
  };
}

/**
 * Where this window of the page is (place.ts): read once as the page opens, then this window's own.
 * Each change is kept on this computer for the next time the page opens, the newest last, and a
 * window never hears of another's. The page draws a change at once and never waits for it to save.
 */
export async function openPlace(client: PageClient & { readonly view: string | null }, document: PingDocument) {
  const key = client.view ?? "";
  let remembered: Place | null = null;
  try {
    remembered = readPlace(((await client.call("place", ModuleFrontendValueSchema.parse({ key }))) as { place?: unknown } | null)?.place);
  } catch {
    /* Opens where the list says, as before. */
  }
  let place = startingPlace(remembered, document);
  // A sheet's window keeps to its sheet, so it has no open sheet to remember.
  if (client.view !== null) delete place.sheetId;
  let waiting: Place | null = null;
  let writing = false;
  async function write() {
    writing = true;
    try {
      while (waiting) {
        const next = waiting;
        waiting = null;
        try {
          await client.call("place", ModuleFrontendValueSchema.parse({ key, place: next }));
        } catch {
          /* The next change says it again. */
        }
      }
    } finally {
      writing = false;
    }
  }
  function change(next: Place) {
    place = next;
    waiting = { ...next };
    if (!writing) void write();
  }
  return {
    get now(): Readonly<Place> {
      return place;
    },
    setSpan(span: SpanId) {
      if (span !== place.span) change({ ...place, span });
    },
    /** null is Auto. */
    setScale(ms: number | null) {
      if (ms === (place.scaleMs ?? null)) return;
      const { scaleMs: _was, ...rest } = place;
      change(ms === null ? rest : { ...rest, scaleMs: ms });
    },
    setSheet(sheetId: string) {
      if (client.view === null && sheetId !== place.sheetId) change({ ...place, sheetId });
    },
    /** Resolves once every change has been passed on. */
    async settled() {
      while (writing || waiting) await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
}
