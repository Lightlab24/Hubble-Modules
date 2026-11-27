import { ModuleFrontendValueSchema, type ModuleFrontendValue } from "@hubble/module-sdk/frontend";
import { DraftStore, followSaved, type SaveReceipt } from "./draft-store.js";
import type { Mutation } from "./model.js";

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
