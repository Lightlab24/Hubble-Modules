/**
 * The Ping page open in two or three HubDash windows at once, all on one running module.
 *
 * Each copy is the page's own code: Hubble's page client (createModuleFrontendClient) on a channel
 * of its own, the device list as the page opens it (openDeviceList: DraftStore and followSaved),
 * and the page's own change builders (changes.ts and model.ts). The host side of each channel does
 * what Hubble does: it passes page commands to the one worker and hands every copy the worker's
 * state when it publishes. The worker has a fake document store and a stand-in for fping, so
 * nothing is pinged. What only a browser can show, the cell being typed in, is checked in
 * tools/qa-windows.mjs against the real page.
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { MODULE_WINDOW_PARTS_LIMIT, ModuleFrontendValueSchema, ModuleWindowPartsSchema, createModuleFrontendClient, type ModuleFrontendValue } from "@hubble/module-sdk/frontend";
import type { ModuleContext } from "@hubble/module-sdk";
import { createBackend, type LiveReply } from "../src/backend.js";
import type { PingProcess } from "../src/engine.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bandsChange, cellEdits, columnMoveChange, columnVisibilityChange, hideColumnChange, resizeChange, settingsChange, viewChange } from "../src/changes.js";
import {
  addSheet,
  defaultDocument,
  DOCUMENT_ID,
  insertRows,
  moveRows,
  moveRowsToSheet,
  moveSheet,
  newDevice,
  removeRows,
  removeSheet,
  renameSheet,
  sheetOf,
  sheetRows,
  sheetsOf,
  valueOf,
  validateDocument,
  type DeviceRow,
  type Mutation,
  type PingDocument,
} from "../src/model.js";
import { openDeviceList, openPlace, revisionIn } from "../src/page-store.js";
import { partTitle, sheetWindow, WINDOW_PARTS_LIMIT, windowParts } from "../src/sheet-window.js";
import source from "../src/manifest.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(check: () => boolean, what: string, tries = 400) {
  for (let i = 0; i < tries && !check(); i++) await delay(5);
  expect(check(), what).toBe(true);
}
const device = (id: string, name: string, host = "", values: Record<string, string> = {}): DeviceRow => ({
  id,
  values: { name, enabled: "TRUE", host, over: "", lost: "", ...values },
});

/** The one running Ping module: the real worker, Hubble's document store as a fake, and no real pings. */
async function runModule(devices: DeviceRow[], change: (doc: PingDocument) => void = () => undefined, runtimeDirectory?: string) {
  const initial = defaultDocument();
  initial.devices = devices;
  change(initial);
  let saved = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: structuredClone(initial) };
  let revisions = 1;
  let writes = 0;
  let conflicts = 0;
  const watchers = new Set<() => void>();
  const services = {
    async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: PingDocument }, signal?: AbortSignal) {
      // A real store answers on its own time, so reads and writes from several windows interleave.
      await delay(1);
      if (input.method === "watch" && input.afterRevision === saved.revision)
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            watchers.delete(wake);
            resolve();
          };
          watchers.add(wake);
          signal?.addEventListener("abort", () => {
            watchers.delete(wake);
            reject(new Error("cancelled"));
          });
        });
      if (input.method === "write") {
        if (input.expectedRevision !== saved.revision) {
          conflicts++;
          return { status: "conflict", document: saved };
        }
        writes++;
        saved = { ...saved, revision: `rev-${++revisions}`, value: structuredClone(input.value!) };
        for (const wake of [...watchers]) wake();
      }
      return { status: "document", document: saved };
    },
  };
  /** Each open page's side of its channel, which Hubble hands the worker's state. */
  const pages = new Set<(state: unknown) => void>();
  let published: unknown;
  const context = {
    connectionEnabled: true,
    ...(runtimeDirectory ? { runtimeDirectory } : {}),
    instanceId: "ping-windows",
    scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "network-ping" },
    settings: {},
    services,
    log: () => undefined,
    publishState: (state: unknown) => {
      published = state;
      for (const push of pages) push(state);
    },
    publishFeedback: () => undefined,
    publishEvent: () => undefined,
  } as unknown as ModuleContext;
  const noPings = (): PingProcess => ({ stdout: { on: () => undefined }, on() { return this; }, kill: () => undefined }) as unknown as PingProcess;
  const instance = createBackend(context, { start: noPings, liveWaitMs: 150 });
  await instance.start!();
  cleanup.push(() => instance.dispose());
  const declared = new Set(source.pages![0]!.sections[0]!.type === "custom" ? source.pages![0]!.sections[0]!.commands!.map((command) => command.id) : []);
  return {
    instance,
    pages,
    declared,
    saved: () => saved.value,
    revision: () => saved.revision,
    /** What the worker published last, which Hubble reads the sidebar's parts from. */
    state: () => published as { values?: Record<string, unknown> } | undefined,
    writes: () => writes,
    /** Saves the store turned away because another had landed first. */
    conflicts: () => conflicts,
    /** Something Hubble itself saves, such as its own Undo or an import. */
    writeFromHubble(value: PingDocument) {
      writes++;
      saved = { ...saved, revision: `rev-${++revisions}`, value: structuredClone(value) };
      for (const wake of [...watchers]) wake();
    },
  };
}
type Module = Awaited<ReturnType<typeof runModule>>;

/**
 * One copy of the page in a window of its own. Hubble passes the page's calls to the worker and,
 * about every 50 ms, the worker's latest state. `hold()` keeps the state from this copy, as if
 * its window were slow to hear, until `release()`. `view` is a sheet's ID for a window the sidebar
 * opened for that one sheet, which Hubble names as the page asks (`titles`); null is the whole page.
 */
async function openWindow(module: Module, view: string | null = null) {
  const channel = new MessageChannel();
  const host = channel.port1;
  let held = false;
  let latest: unknown;
  const titles: string[] = [];
  /** Every change this copy sent to be saved. */
  const operations: Mutation[] = [];
  host.addEventListener("message", (event: MessageEvent) => {
    const request = event.data as { id: string; operation: string; commandId?: string; value?: unknown; title?: string };
    if (request.operation === "window-title") {
      // As Hubble: only a window that shows one part of the page takes a title from the page.
      if (view === null) host.postMessage({ type: "error", id: request.id, message: "This page is not in a window of its own" });
      else {
        titles.push(request.title!);
        host.postMessage({ type: "result", id: request.id, value: null });
      }
      return;
    }
    if (request.operation === "call" && request.commandId === "save") operations.push(structuredClone((request.value as { operation: Mutation }).operation));
    void (async () => {
      try {
        if (request.operation !== "call" || !module.declared.has(request.commandId!)) throw Error(`Module page command is not declared: ${request.commandId}`);
        const value = await module.instance.call!("page.ping", { sectionId: "frontend", commandId: request.commandId, value: request.value } as never, { signal: new AbortController().signal } as never);
        host.postMessage({ type: "result", id: request.id, value: ModuleFrontendValueSchema.parse(JSON.parse(JSON.stringify(value))) });
      } catch (error) {
        host.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  host.start();
  const push = (state: unknown) => {
    latest = state;
    if (!held) setTimeout(() => host.postMessage({ type: "state", value: JSON.parse(JSON.stringify(state)) }), 10);
  };
  module.pages.add(push);
  const client = createModuleFrontendClient(channel.port2 as never, { view, canOpen: true });
  const list = await openDeviceList(client);
  // Where this copy is, and the sheet it shows, as the page works them out (frontend.ts).
  const place = await openPlace(client, list.store.document);
  const shown = sheetWindow(client, list.store, place.now.sheetId);
  const errors: string[] = [];
  const clashes: string[] = [];
  list.store.subscribe(() => {
    if (list.store.error && errors.at(-1) !== list.store.error) errors.push(list.store.error);
  });
  list.store.onClash((found) => clashes.push(...found));
  const copy = {
    ...list,
    client,
    shown,
    place,
    titles,
    operations,
    errors,
    clashes,
    get doc() {
      return list.store.document;
    },
    submit: (operation: Mutation | null, remember = true) => (operation ? list.store.submit(operation, remember) : true),
    /** A sheet tab clicked, as the page does it. */
    openSheet(id: string) {
      if (shown.open(id)) place.setSheet(id);
    },
    /** Add sheet, as the page does it: the new sheet opens in this window. */
    addSheet(id: string, name: string) {
      if (list.store.submit(addSheet(list.store.document, id, name))) copy.openSheet(id);
    },
    /** Remove sheet, as the page does it once any question is answered. */
    removeSheet(id: string) {
      const again = removeSheet(list.store.document, id);
      if (!again) return;
      shown.leave(id);
      const { removed: _gone, ...change } = again;
      if (!list.store.submit(change)) shown.open(id);
      place.setSheet(shown.openId());
    },
    /** Types into cells the way the grid's editor and paste do. */
    type: (edits: { rowId: string; columnId: string; value: string }[], expected?: string) => list.store.submit({ kind: "edit", edits: cellEdits(list.store.document, edits, expected) }),
    hold() {
      held = true;
    },
    release() {
      held = false;
      if (latest !== undefined) push(latest);
    },
    /** One ping update, as the page's live loop asks for it: its revision reaches followSaved too. */
    async live() {
      const reply = (await client.call("live", { after: 0 } as ModuleFrontendValue)) as unknown as LiveReply;
      list.follow.saw(reply.revision);
      return reply;
    },
  };
  cleanup.push(() => {
    module.pages.delete(push);
    shown.dispose();
    list.close();
    client.dispose();
    host.close();
  });
  return copy;
}
type Copy = Awaited<ReturnType<typeof openWindow>>;

/** Every copy has nothing waiting to save and holds the list as saved. */
async function settled(module: Module, copies: Copy[], what = "every copy holds the list as saved") {
  await until(() => copies.every((copy) => !copy.store.pending.length && copy.store.revision === module.revision()), what);
  for (const copy of copies) expect(copy.doc).toEqual(module.saved());
}

describe("the Ping page in several windows", () => {
  it("follows what another window saves, without a reload", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two, three] = [await openWindow(module), await openWindow(module), await openWindow(module)];
    const added = one.shown.newDevice("b")!;
    one.submit(insertRows(one.doc, [added], null));
    one.type([{ rowId: "b", columnId: "host", value: "10.0.0.2" }]);
    two.submit(settingsChange(two.doc, { intervalMs: 500 }));
    three.submit(viewChange(three.doc, { textSize: 16 }));
    await settled(module, [one, two, three]);
    for (const copy of [one, two, three]) {
      expect(copy.doc.devices.map((row) => valueOf(row, "host"))).toEqual(["10.0.0.1", "10.0.0.2"]);
      expect(copy.doc.settings.intervalMs).toBe(500);
      expect(copy.doc.view.textSize).toBe(16);
      expect(copy.errors).toEqual([]);
    }
  });

  it("hears of a save from a ping update too, when Hubble's state is slow to come", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.type([{ rowId: "a", columnId: "name", value: "Core switch" }]);
    await settled(module, [one], "the first copy saved");
    expect(valueOf(two.doc.devices[0]!, "name")).toBe("Router");
    await two.live();
    await until(() => valueOf(two.doc.devices[0]!, "name") === "Core switch", "the ping update's revision brought the list");
  });

  it("never refuses a copy for being behind, and keeps every window's changes", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Camera 1", "10.0.0.11"), device("c", "Camera 2", "10.0.0.12")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    // The second window doesn't hear of anything the first does until the end.
    two.hold();
    one.submit(insertRows(one.doc, [one.shown.newDevice("d")!], null)); // Device 4
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.254" }]);
    one.submit(settingsChange(one.doc, { intervalMs: 2000 }));
    one.submit(resizeChange(one.doc, "column", "host", 200));
    one.addSheet("s2", "Cameras");
    one.openSheet("devices");
    await settled(module, [one], "the first window saved everything");

    // The second window still shows the list as it was opened, and changes every kind of thing.
    expect(two.doc.devices).toHaveLength(3);
    expect(two.submit(insertRows(two.doc, [two.shown.newDevice("e")!], null))).toBe(true); // also "Device 4" here
    expect(two.type([{ rowId: "b", columnId: "over", value: "80" }])).toBe(true);
    expect(two.submit(moveRows(two.doc, ["c"], "b"))).toBe(true);
    expect(two.submit(removeRows(two.doc, ["e"]))).toBe(true);
    expect(two.submit(insertRows(two.doc, [two.shown.newDevice("f")!], "a"))).toBe(true);
    expect(two.submit(settingsChange(two.doc, { notify: false }))).toBe(true);
    expect(two.submit(viewChange(two.doc, { textSize: 18 }))).toBe(true);
    expect(two.submit(columnVisibilityChange(two.doc, "best", true))).toBe(true);
    expect(two.submit(columnMoveChange(two.doc, "status", "enabled"))).toBe(true);
    expect(two.submit(resizeChange(two.doc, "column", "name", 220))).toBe(true);
    expect(two.submit(bandsChange(two.doc, { green: 5, yellow: 20, orange: null }))).toBe(true);
    expect(two.submit(renameSheet(two.doc, "devices", "Main")!)).toBe(true);
    expect(two.submit(addSheet(two.doc, "s3", "Sheet 2"))).toBe(true);
    two.release();
    await settled(module, [one, two]);

    const saved = module.saved();
    expect(two.errors).toEqual([]);
    expect(one.errors).toEqual([]);
    // Both windows' devices are there, in the order each asked for, and the second window's new
    // device took the next free name rather than being refused for "Device 4".
    expect(saved.devices.map((row) => row.id)).toEqual(["f", "a", "c", "b", "d"]);
    expect(saved.devices.map((row) => valueOf(row, "name"))).toEqual(["Device 5", "Router", "Camera 2", "Camera 1", "Device 4"]);
    expect(valueOf(saved.devices.find((row) => row.id === "a")!, "host")).toBe("10.0.0.254");
    expect(valueOf(saved.devices.find((row) => row.id === "b")!, "over")).toBe("80");
    expect(saved.settings).toMatchObject({ intervalMs: 2000, notify: false });
    expect(saved.view).toMatchObject({ span: "10m", textSize: 18, bands: { green: 5, yellow: 20, orange: null } });
    expect(saved.view.widths).toEqual({ host: 200, name: 220 });
    expect(saved.view.hidden).not.toContain("best");
    expect(saved.view.order.indexOf("status")).toBe(saved.view.order.indexOf("enabled") - 1);
    expect(sheetsOf(saved).map((sheet) => sheet.name)).toEqual(["Main", "Cameras", "Sheet 2"]);
    expect(two.clashes).toEqual([]);
  });

  it("keeps what was typed last when two windows change the same cell, and says so in that window", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    // The second window opens the cell's editor over 10.0.0.1, as the grid does.
    const expected = valueOf(two.doc.devices[0]!, "host");
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.5" }]);
    await settled(module, [one, two], "the second window followed while its editor was open");
    // What the editor shows is the operator's typing; the store followed underneath.
    expect(valueOf(two.doc.devices[0]!, "host")).toBe("10.0.0.5");
    two.type([{ rowId: "a", columnId: "host", value: "10.0.0.7" }], expected);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().devices[0]!, "host")).toBe("10.0.0.7");
    expect(two.clashes).toEqual(["Router's IP Address"]);
    expect(one.clashes).toEqual([]);
    expect([...one.errors, ...two.errors]).toEqual([]);
  });

  it("keeps a red draft in its cell while other windows save", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    expect(two.type([{ rowId: "a", columnId: "host", value: "not an address" }])).toBe(false);
    expect(two.store.invalid.get("a/host")?.edit.value).toBe("not an address");
    one.type([{ rowId: "b", columnId: "name", value: "Core" }]);
    one.submit(viewChange(one.doc, { textSize: 15 }));
    await settled(module, [one, two]);
    expect(two.store.invalid.get("a/host")?.edit.value).toBe("not an address");
  });

  it("puts back only a refused change, and the window then holds the list as saved", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(removeRows(one.doc, ["b"]));
    await settled(module, [one]);
    // The second window types into the device the first removed, then changes something else.
    two.type([{ rowId: "b", columnId: "host", value: "10.0.0.9" }]);
    two.type([{ rowId: "a", columnId: "name", value: "Edge" }]);
    await until(() => !two.store.pending.length, "the second window's saves were answered");
    expect(two.errors).toEqual(["That device was removed before the change saved."]);
    // It read the list again at once, without hearing from Hubble: the device is gone, the other change landed.
    await until(() => two.store.revision === module.revision(), "the refused window read the list again");
    expect(two.doc).toEqual(module.saved());
    expect(two.doc.devices.map((row) => valueOf(row, "name"))).toEqual(["Edge"]);
    expect(two.store.invalid.size).toBe(0);
    // Its next change isn't refused for the same reason.
    expect(two.type([{ rowId: "a", columnId: "host", value: "10.0.0.3" }])).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(two.errors).toHaveLength(1);
  });

  it("doesn't report a clash for an edit made over a value that was refused here", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.type([{ rowId: "b", columnId: "name", value: "Core" }]);
    await settled(module, [one]);
    // The second window hasn't heard: "Core" looks free to it, and its next name is typed over that.
    expect(two.type([{ rowId: "a", columnId: "name", value: "Core" }])).toBe(true);
    expect(two.type([{ rowId: "a", columnId: "name", value: "Core 2" }])).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(two.errors).toEqual(["Another device is already called Core. Buttons pick devices by name."]);
    expect(module.saved().devices.map((row) => valueOf(row, "name"))).toEqual(["Core 2", "Core"]);
    expect(two.clashes).toEqual([]);
  });

  it("undoes only this window's change, and never another window's", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.50" }]);
    one.submit(insertRows(one.doc, [one.shown.newDevice("c")!], null));
    await settled(module, [one, two]);
    // The second window changes the device the first window added, and adds one of its own.
    two.type([{ rowId: "c", columnId: "host", value: "10.0.0.60" }]);
    two.submit(insertRows(two.doc, [two.shown.newDevice("d")!], null));
    await settled(module, [one, two]);

    // Undo in the first window: taking its device off would lose the second window's address, so it stays.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(module.saved().devices.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(one.errors.at(-1)).toBe("Device 3 was changed in another window since, so it was left as it is.");
    // That Undo is used up; the next one puts back the first window's own address, and nothing else.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().devices[0]!, "host")).toBe("10.0.0.1");
    expect(valueOf(module.saved().devices[2]!, "host")).toBe("10.0.0.60");
    expect(module.saved().devices.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    // Redo brings the first window's address back.
    one.store.history(true);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().devices[0]!, "host")).toBe("10.0.0.50");

    // A cell another window changed since is left alone by Undo too.
    two.type([{ rowId: "a", columnId: "host", value: "10.0.0.70" }]);
    await settled(module, [one, two]);
    one.store.history(false);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().devices[0]!, "host")).toBe("10.0.0.70");
    expect(one.errors.at(-1)).toBe("Router's IP Address was changed in another window since, so it was left as it is.");
  });

  it("refuses an Undo the worker finds another window has overtaken, and takes it off the Redo list", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.2" }]);
    await settled(module, [one, two]);
    one.hold();
    two.type([{ rowId: "a", columnId: "host", value: "10.0.0.3" }]);
    await settled(module, [two]);
    // The first window hasn't heard, so its Undo looks fine to it, and the worker refuses it.
    one.store.history(false);
    await until(() => !one.store.pending.length, "the Undo was answered");
    expect(one.errors.at(-1)).toBe("Router's IP Address was changed in another window since, so it was left as it is.");
    expect(one.store.redo).toEqual([]);
    expect(one.store.undo).toEqual([]);
    await until(() => one.store.revision === module.revision(), "the refused window read the list again");
    expect(valueOf(one.doc.devices[0]!, "host")).toBe("10.0.0.3");
  });

  it("never refuses a layout change, and a layout change never undoes an edit", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2")]);
    const [one, two, three] = [await openWindow(module), await openWindow(module), await openWindow(module)];
    for (const copy of [two, three]) copy.hold();
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.100" }]);
    one.submit(settingsChange(one.doc, { alertOverMs: 50 }));
    one.submit(insertRows(one.doc, [one.shown.newDevice("c")!], null));
    await settled(module, [one]);
    // The other two still show the old list and only change the layout.
    expect(two.submit(resizeChange(two.doc, "column", "host", 180))).toBe(true);
    expect(two.submit(hideColumnChange(two.doc, "jitter"))).toBe(true);
    expect(three.submit(viewChange(three.doc, { textSize: 11 }))).toBe(true);
    expect(three.submit(resizeChange(three.doc, "row", "a", 48))).toBe(true);
    for (const copy of [two, three]) copy.release();
    await settled(module, [one, two, three]);
    const saved = module.saved();
    expect(valueOf(saved.devices[0]!, "host")).toBe("10.0.0.100");
    expect(saved.settings.alertOverMs).toBe(50);
    expect(saved.devices.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(saved.view).toMatchObject({ textSize: 11, rowHeights: { a: 48 }, widths: { host: 180 } });
    expect(saved.view.hidden).toContain("jitter");
    expect([...one.errors, ...two.errors, ...three.errors]).toEqual([]);
  });

  it("keeps each window's own sheet, Show last and scale, and saves none of them with the list", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Camera 1", "10.0.0.11")], (doc) => {
      doc.sheets = [{ id: "devices", name: "Network" }, { id: "cams", name: "Cameras" }];
      doc.devices[1] = { ...doc.devices[1]!, sheetId: "cams" };
    });
    const [one, two] = [await openWindow(module), await openWindow(module)];
    const writes = module.writes();
    // The first window goes to Cameras, the last hour and a 5 ms scale; the second stays where it opened.
    one.openSheet("cams");
    one.place.setSpan("1h");
    one.place.setScale(5);
    await one.place.settled();
    // The second picks a time and scale of its own, and adds a sheet, which opens there and only there.
    two.place.setSpan("1m");
    two.place.setScale(null);
    two.addSheet("lights", "Lights");
    await settled(module, [one, two]);
    await Promise.all([one.place.settled(), two.place.settled()]);
    expect(one.shown.openId()).toBe("cams");
    expect(one.shown.rows().map((row) => row.id)).toEqual(["b"]);
    expect(one.place.now).toEqual({ span: "1h", scaleMs: 5, sheetId: "cams" });
    expect(two.shown.openId()).toBe("lights");
    expect(two.place.now).toEqual({ span: "1m", sheetId: "lights" });
    // Only the new sheet was saved: what each window looks at is no change to the list.
    expect(module.writes() - writes).toBe(1);
    expect(two.operations.map((operation) => operation.kind)).toEqual(["sheets"]);
    expect(one.operations).toEqual([]);
    expect(module.saved().view).toEqual(defaultDocument().view);
    // A window opened now starts where the page was left last, which was the second window.
    const three = await openWindow(module);
    expect(three.place.now).toEqual({ span: "1m", sheetId: "lights" });
    expect(three.shown.openId()).toBe("lights");
    expect([...one.errors, ...two.errors, ...three.errors]).toEqual([]);
  });

  it("moves a window off its sheet only when that sheet is removed, and back when an Undo brings it again", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")], (doc) => {
      doc.sheets = [{ id: "devices", name: "Network" }, { id: "cams", name: "Cameras" }, { id: "lights", name: "Lights" }];
    });
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.openSheet("cams");
    two.openSheet("lights");
    // The first window removes the sheet it shows: the one beside it opens there, and the other window stays put.
    one.removeSheet("cams");
    await settled(module, [one, two]);
    expect(one.shown.openId()).toBe("lights");
    expect(two.shown.openId()).toBe("lights");
    // Its Undo brings the sheet back, and opens it again in that window only.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(sheetsOf(module.saved()).map((sheet) => sheet.id)).toEqual(["devices", "cams", "lights"]);
    expect(one.shown.openId()).toBe("cams");
    expect(two.shown.openId()).toBe("lights");
    // Now the first window removes the sheet the second one shows: the second goes back to the sheet it had open before.
    one.removeSheet("lights");
    await settled(module, [one, two]);
    expect(one.shown.openId()).toBe("cams");
    expect(two.shown.openId()).toBe("devices");
    // An Undo there brings it back to the second window as well, since nothing else was opened there meanwhile.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(two.shown.openId()).toBe("lights");
    expect(one.shown.openId()).toBe("cams");
    // Undoing a sheet this window added goes back to the sheet it had open before.
    two.addSheet("rigs", "Rigs");
    await settled(module, [one, two]);
    expect(two.shown.openId()).toBe("rigs");
    two.store.history(false);
    await settled(module, [one, two]);
    expect(two.shown.openId()).toBe("lights");
    expect(module.saved().view.sheetId).toBeUndefined();
    expect([...one.errors, ...two.errors]).toEqual([]);
  });

  it("remembers where each window was left on this computer, never in the workspace", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "ping-places-"));
    cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
    const twoSheets = (doc: PingDocument) => {
      doc.sheets = [{ id: "devices", name: "Network" }, { id: "cams", name: "Cameras" }];
      // As 0.2.0 saved it: one place for every window.
      doc.view = { ...doc.view, span: "6h", sheetId: "cams", scaleMs: 3 };
    };
    const module = await runModule([device("a", "Router", "10.0.0.1")], twoSheets, folder);
    const whole = await openWindow(module);
    // Never left anywhere yet, so a window opens where the list said before 0.2.1.
    expect(whole.place.now).toEqual({ span: "6h", sheetId: "cams", scaleMs: 3 });
    expect(whole.shown.openId()).toBe("cams");
    // A sheet's own window starts with the whole page's time and scale, and has no open sheet.
    expect((await openWindow(module, "cams")).place.now).toEqual({ span: "6h", scaleMs: 3 });
    whole.openSheet("devices");
    whole.place.setSpan("24h");
    whole.place.setScale(null);
    await whole.place.settled();
    const cams = await openWindow(module, "cams");
    expect(cams.place.now).toEqual({ span: "24h" });
    cams.place.setSpan("1m");
    cams.place.setScale(12.5);
    await cams.place.settled();
    const saved = JSON.parse(readFileSync(path.join(folder, "page-view.json"), "utf8")) as { places: Record<string, { place: unknown }> };
    expect(saved.places[""]?.place).toEqual({ span: "24h", sheetId: "devices" });
    expect(saved.places.cams?.place).toEqual({ span: "1m", scaleMs: 12.5 });
    // The list as saved in the workspace is just as it was.
    expect(module.writes()).toBe(0);
    expect(module.saved().view).toMatchObject({ span: "6h", sheetId: "cams", scaleMs: 3 });
    // After a restart the module reads the folder again: each window opens where it was left.
    const again = await runModule([device("a", "Router", "10.0.0.1")], twoSheets, folder);
    expect((await openWindow(again)).place.now).toEqual({ span: "24h", sheetId: "devices" });
    expect((await openWindow(again, "cams")).place.now).toEqual({ span: "1m", scaleMs: 12.5 });
    // A place that isn't one is refused, and nothing is kept for it.
    const refused = (value: unknown) => again.instance.call!("page.ping", { sectionId: "frontend", commandId: "place", value } as never, { signal: new AbortController().signal } as never);
    await expect(refused({ key: "", place: { span: "2 days" } })).rejects.toThrow("That isn't a place on the Ping page.");
    await expect(refused({ key: "x".repeat(129), place: { span: "1m" } })).rejects.toThrow("That isn't a place on the Ping page.");
    await expect(refused({ place: { span: "1m" } })).rejects.toThrow("Say which window of the Ping page this is.");
  });

  it("counts another window's new devices toward a Devices box number, and never takes them off", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(insertRows(one.doc, [one.shown.newDevice("b")!], null));
    await settled(module, [one]);
    // The second window still counts one device and asks for three.
    const { removed: _none, ...grow } = two.shown.count(3, (() => { let n = 0; return () => `new-${++n}`; })())!;
    expect(two.submit(grow)).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(sheetRows(module.saved(), "devices")).toHaveLength(3);
    expect(module.saved().devices.map((row) => row.id)).toEqual(["a", "b", "new-1"]);
    // Asking for one takes off only what that window was shown; nothing it never saw goes.
    two.hold();
    one.submit(insertRows(one.doc, [one.shown.newDevice("c")!], null));
    await settled(module, [one]);
    const { removed, ...shrink } = two.shown.count(1, () => "unused")!;
    expect(removed.map((row) => row.id)).toEqual(["b", "new-1"]);
    expect(two.submit(shrink)).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(module.saved().devices.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("moves a removed sheet's devices that another window added to the first sheet, rather than losing them", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")], (doc) => {
      doc.sheets = [{ id: "devices", name: "Devices" }, { id: "cams", name: "Cameras" }];
      doc.devices.push({ ...device("b", "Camera 1", "10.0.0.11"), sheetId: "cams" });
    });
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(insertRows(one.doc, [newDevice(one.doc, "c", "cams")], null));
    one.submit(moveRowsToSheet(one.doc, ["a"], "cams")!);
    await settled(module, [one]);
    const { removed, ...remove } = removeSheet(two.doc, "cams")!;
    expect(removed.map((row) => row.id)).toEqual(["b"]);
    expect(two.submit(remove)).toBe(true);
    two.release();
    await settled(module, [one, two]);
    const saved = module.saved();
    expect(sheetsOf(saved).map((sheet) => sheet.id)).toEqual(["devices"]);
    // Camera 1, which the second window removed with its sheet, is gone; the rest stay, on Devices.
    expect(saved.devices.map((row) => row.id)).toEqual(["a", "c"]);
    expect(saved.devices.map((row) => sheetOf(saved, row))).toEqual(["devices", "devices"]);
    expect([...one.errors, ...two.errors]).toEqual([]);
  });

  it("takes three windows saving at once, each change once, and then saves nothing more", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("b", "Switch", "10.0.0.2"), device("c", "Camera", "10.0.0.3")]);
    const copies = [await openWindow(module), await openWindow(module), await openWindow(module)];
    const before = module.writes();
    const [one, two, three] = copies;
    // No waiting between them: the three saves reach the worker together.
    one!.type([{ rowId: "a", columnId: "over", value: "20" }]);
    two!.type([{ rowId: "b", columnId: "over", value: "30" }]);
    three!.type([{ rowId: "c", columnId: "over", value: "40" }]);
    one!.submit(insertRows(one!.doc, [one!.shown.newDevice("d")!], null));
    two!.submit(insertRows(two!.doc, [two!.shown.newDevice("e")!], null));
    three!.submit(viewChange(three!.doc, { textSize: 12 }));
    await settled(module, copies);
    expect(module.writes() - before).toBe(6);
    // The worker saves one change at a time, so the windows never collide in the store.
    expect(module.conflicts()).toBe(0);
    const saved = module.saved();
    expect(saved.devices.map((row) => valueOf(row, "over"))).toEqual(["20", "30", "40", "", ""]);
    expect(saved.devices.map((row) => valueOf(row, "name"))).toEqual(["Router", "Switch", "Camera", "Device 4", "Device 5"]);
    expect(copies.flatMap((copy) => copy.errors)).toEqual([]);
    // Nobody saves anything by itself afterwards: following another window writes nothing.
    await delay(300);
    expect(module.writes() - before).toBe(6);
  });

  it("writes nothing when a window saves what another window already saved", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(settingsChange(one.doc, { pinging: false }));
    await settled(module, [one]);
    const before = module.writes();
    two.submit(settingsChange(two.doc, { pinging: false }));
    two.release();
    await settled(module, [one, two]);
    expect(module.writes()).toBe(before);
    expect([...one.errors, ...two.errors, ...two.clashes]).toEqual([]);
  });

  it("follows a change Hubble itself saves, such as its own Undo", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    const restored = structuredClone(module.saved());
    restored.devices.push(device("z", "Restored", "10.0.0.26"));
    module.writeFromHubble(restored);
    await settled(module, [one, two]);
    expect(one.doc.devices.map((row) => row.id)).toEqual(["a", "z"]);
  });

  it("keeps the worker's revision in its state for every copy to follow", async () => {
    const module = await runModule([]);
    const one = await openWindow(module);
    const states: unknown[] = [];
    const stop = one.client.subscribe((state) => states.push(state));
    one.submit(insertRows(one.doc, [one.shown.newDevice("a")!], null));
    await settled(module, [one]);
    await until(() => states.some((state) => revisionIn(state) === module.revision()), "the state carried the new revision");
    stop();
  });
});

describe("a sheet in a window of its own", () => {
  /** Network holds the router, Cameras every device whose ID starts with "cam". */
  const twoSheets = (doc: PingDocument) => {
    doc.sheets = [{ id: "devices", name: "Network" }, { id: "cams", name: "Cameras" }];
    doc.devices = doc.devices.map((row) => (row.id.startsWith("cam") ? { ...row, sheetId: "cams" } : row));
  };
  const parts = (module: Module) => module.state()?.values?.windowParts;

  it("lists each sheet for the sidebar by its ID, and again when one is added, renamed, moved or removed", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")], (doc) => (doc.sheets = [{ id: "devices", name: "Cameras" }]));
    const whole = await openWindow(module);
    expect(parts(module)).toEqual([{ view: "devices", title: "Cameras" }]);
    whole.submit(addSheet(whole.doc, "lights", "Lights"));
    await settled(module, [whole]);
    expect(parts(module)).toEqual([{ view: "devices", title: "Cameras" }, { view: "lights", title: "Lights" }]);
    whole.submit(renameSheet(whole.doc, "lights", "Lighting desk")!);
    whole.submit(moveSheet(whole.doc, "lights", "devices")!);
    await settled(module, [whole]);
    expect(parts(module)).toEqual([{ view: "lights", title: "Lighting desk" }, { view: "devices", title: "Cameras" }]);
    const { removed: _none, ...remove } = removeSheet(whole.doc, "lights")!;
    whole.submit(remove);
    await settled(module, [whole]);
    expect(parts(module)).toEqual([{ view: "devices", title: "Cameras" }]);
    // Hubble reads the list with this, and lists no parts at all for anything it refuses.
    expect(ModuleWindowPartsSchema.safeParse(parts(module)).success).toBe(true);
  });

  it("lists up to 24 sheets with one-line titles, and the one sheet of a list that never had more", () => {
    expect(WINDOW_PARTS_LIMIT).toBe(MODULE_WINDOW_PARTS_LIMIT);
    expect(windowParts(defaultDocument())).toEqual([{ view: "devices", title: "Devices" }]);
    const doc = defaultDocument();
    doc.sheets = Array.from({ length: 30 }, (_, index) => ({ id: `sheet-${index + 1}`, name: index === 2 ? "Stage\nleft " : `Sheet ${index + 1}` }));
    const listed = windowParts(validateDocument(doc));
    expect(listed).toHaveLength(24);
    expect(listed[2]).toEqual({ view: "sheet-3", title: "Stage left" });
    expect(ModuleWindowPartsSchema.safeParse(listed).success).toBe(true);
    expect(partTitle(" \t ")).toBe("Sheet");
    expect(partTitle("Bell\u0007box")).toBe("Bell box");
  });

  it("keeps to its own sheet whichever sheet the whole page opens", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("cam-1", "Camera 1", "10.0.0.11")], twoSheets);
    const whole = await openWindow(module);
    const cams = await openWindow(module, "cams");
    expect(whole.shown.openId()).toBe("devices");
    expect(cams.shown.rows().map((row) => row.id)).toEqual(["cam-1"]);
    // The whole page opens Cameras, then Network again: the sheet's window stays on Cameras.
    whole.openSheet("cams");
    await settled(module, [whole, cams]);
    whole.openSheet("devices");
    await settled(module, [whole, cams]);
    expect(cams.shown.sheet()?.id).toBe("cams");
    // What is done in the sheet's window goes onto its sheet: a device added, the Devices box, a
    // typed address and its Undo, and the layout and settings every window shares.
    cams.submit(insertRows(cams.doc, [cams.shown.newDevice("cam-2")!], null));
    let added = 0;
    const { removed: _none, ...grow } = cams.shown.count(4, () => `cam-new-${++added}`)!;
    cams.submit(grow);
    cams.type([{ rowId: "cam-1", columnId: "host", value: "10.0.0.99" }]);
    cams.store.history(false);
    cams.submit(viewChange(cams.doc, { textSize: 15 }));
    cams.submit(settingsChange(cams.doc, { intervalMs: 2000 }));
    await settled(module, [whole, cams]);
    const saved = module.saved();
    expect(sheetRows(saved, "cams").map((row) => row.id)).toEqual(["cam-1", "cam-2", "cam-new-1", "cam-new-2"]);
    expect(sheetRows(saved, "devices").map((row) => row.id)).toEqual(["a"]);
    expect(valueOf(saved.devices.find((row) => row.id === "cam-1")!, "host")).toBe("10.0.0.11");
    expect(saved.view.textSize).toBe(15);
    expect(saved.settings.intervalMs).toBe(2000);
    // The whole page is still on the sheet it had open: nothing the sheet's window sent moves it.
    expect(saved.view.sheetId).toBeUndefined();
    expect(whole.shown.openId()).toBe("devices");
    expect(cams.operations.map((operation) => operation.kind)).toEqual(["rows", "rows", "edit", "edit", "view", "settings"]);
    for (const operation of cams.operations) if (operation.kind === "view") expect(operation.view.sheetId).toBe(operation.expected.sheetId);
    expect([...whole.errors, ...cams.errors]).toEqual([]);
  });

  it("takes the whole page and two sheets' windows adding devices at once, each onto its own sheet", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")], (doc) => {
      doc.sheets = [{ id: "devices", name: "Network" }, { id: "cams", name: "Cameras" }, { id: "lights", name: "Lights" }];
    });
    const whole = await openWindow(module);
    const cams = await openWindow(module, "cams");
    const lights = await openWindow(module, "lights");
    for (const [copy, prefix] of [[whole, "w"], [cams, "c"], [lights, "l"]] as const)
      for (const n of [1, 2]) copy.submit(insertRows(copy.doc, [copy.shown.newDevice(`${prefix}${n}`)!], null));
    await settled(module, [whole, cams, lights]);
    const saved = module.saved();
    expect(sheetRows(saved, "devices").map((row) => row.id)).toEqual(["a", "w1", "w2"]);
    expect(sheetRows(saved, "cams").map((row) => row.id)).toEqual(["c1", "c2"]);
    expect(sheetRows(saved, "lights").map((row) => row.id)).toEqual(["l1", "l2"]);
    // Each "Device N" another window had taken by then moved on to a free number.
    expect(new Set(saved.devices.map((row) => valueOf(row, "name").toLowerCase())).size).toBe(saved.devices.length);
    expect(module.conflicts()).toBe(0);
    expect(saved.view.sheetId).toBeUndefined();
    expect([...whole.errors, ...cams.errors, ...lights.errors]).toEqual([]);
  });

  it("names its window after its sheet at once, and again when any window renames that sheet", async () => {
    const module = await runModule([], twoSheets);
    const cams = await openWindow(module, "cams");
    await until(() => cams.titles.length === 1, "the window was named on opening");
    expect(cams.titles).toEqual(["Cameras"]);
    const whole = await openWindow(module);
    whole.submit(renameSheet(whole.doc, "cams", "Studio cameras")!);
    await until(() => cams.titles.length === 2, "the window was renamed with its sheet");
    expect(cams.titles).toEqual(["Cameras", "Studio cameras"]);
    // Another sheet's new name, or any other change, leaves the title as it is.
    whole.submit(renameSheet(whole.doc, "devices", "Switches")!);
    whole.submit(settingsChange(whole.doc, { intervalMs: 500 }));
    await settled(module, [whole, cams]);
    await delay(50);
    expect(cams.titles).toEqual(["Cameras", "Studio cameras"]);
    // The whole page has no window title of its own to set.
    expect(whole.titles).toEqual([]);
  });

  it("is no longer here once another window removes its sheet, and shows it again after Undo there", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1"), device("cam-1", "Camera 1", "10.0.0.11")], twoSheets);
    const whole = await openWindow(module);
    const cams = await openWindow(module, "cams");
    const { removed: _gone, ...remove } = removeSheet(whole.doc, "cams")!;
    whole.submit(remove);
    await settled(module, [whole, cams]);
    expect(cams.shown.gone()).toBe(true);
    expect(cams.shown.rows()).toEqual([]);
    // Nothing goes onto a sheet that is gone.
    expect(cams.shown.newDevice("x")).toBeUndefined();
    expect(cams.shown.count(3, () => "y")).toBeNull();
    whole.store.history(false);
    await settled(module, [whole, cams]);
    expect(cams.shown.gone()).toBe(false);
    expect(cams.shown.rows().map((row) => row.id)).toEqual(["cam-1"]);
    expect(cams.titles).toEqual(["Cameras"]);
    // A window HubDash opens again for a sheet removed meanwhile is no longer here from the start.
    const late = await openWindow(module, "removed-before");
    expect(late.shown.gone()).toBe(true);
    await delay(30);
    expect(late.titles).toEqual([]);
    expect([...whole.errors, ...cams.errors, ...late.errors]).toEqual([]);
  });
});
