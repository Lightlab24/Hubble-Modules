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
import { ModuleFrontendValueSchema, createModuleFrontendClient, type ModuleFrontendValue } from "@hubble/module-sdk/frontend";
import type { ModuleContext } from "@hubble/module-sdk";
import { createBackend, type LiveReply } from "../src/backend.js";
import type { PingProcess } from "../src/engine.js";
import { bandsChange, cellEdits, columnMoveChange, columnVisibilityChange, hideColumnChange, openSheetChange, resizeChange, scaleChange, settingsChange, viewChange } from "../src/changes.js";
import {
  addSheet,
  defaultDocument,
  DOCUMENT_ID,
  insertRows,
  moveRows,
  moveRowsToSheet,
  moveSheet,
  newDevice,
  openSheetId,
  removeRows,
  removeSheet,
  renameSheet,
  setDeviceCount,
  sheetOf,
  sheetRows,
  sheetsOf,
  valueOf,
  type DeviceRow,
  type Mutation,
  type PingDocument,
} from "../src/model.js";
import { openDeviceList, revisionIn } from "../src/page-store.js";
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
async function runModule(devices: DeviceRow[], change: (doc: PingDocument) => void = () => undefined) {
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
  const context = {
    connectionEnabled: true,
    instanceId: "ping-windows",
    scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "network-ping" },
    settings: {},
    services,
    log: () => undefined,
    publishState: (state: unknown) => {
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
 * its window were slow to hear, until `release()`.
 */
async function openWindow(module: Module) {
  const channel = new MessageChannel();
  const host = channel.port1;
  let held = false;
  let latest: unknown;
  host.addEventListener("message", (event: MessageEvent) => {
    const request = event.data as { id: string; operation: string; commandId?: string; value?: unknown };
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
  const client = createModuleFrontendClient(channel.port2 as never);
  const list = await openDeviceList(client);
  const errors: string[] = [];
  const clashes: string[] = [];
  list.store.subscribe(() => {
    if (list.store.error && errors.at(-1) !== list.store.error) errors.push(list.store.error);
  });
  list.store.onClash((found) => clashes.push(...found));
  const copy = {
    ...list,
    client,
    errors,
    clashes,
    get doc() {
      return list.store.document;
    },
    submit: (operation: Mutation | null, remember = true) => (operation ? list.store.submit(operation, remember) : true),
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
    const added = newDevice(one.doc, "b");
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
    one.submit(insertRows(one.doc, [newDevice(one.doc, "d")], null)); // Device 4
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.254" }]);
    one.submit(settingsChange(one.doc, { intervalMs: 2000 }));
    one.submit(viewChange(one.doc, { span: "1h" }));
    one.submit(resizeChange(one.doc, "column", "host", 200));
    one.submit(addSheet(one.doc, "s2", "Cameras"));
    one.submit(openSheetChange(one.doc, "devices"), false);
    await settled(module, [one], "the first window saved everything");

    // The second window still shows the list as it was opened, and changes every kind of thing.
    expect(two.doc.devices).toHaveLength(3);
    expect(two.submit(insertRows(two.doc, [newDevice(two.doc, "e")], null))).toBe(true); // also "Device 4" here
    expect(two.type([{ rowId: "b", columnId: "over", value: "80" }])).toBe(true);
    expect(two.submit(moveRows(two.doc, ["c"], "b"))).toBe(true);
    expect(two.submit(removeRows(two.doc, ["e"]))).toBe(true);
    expect(two.submit(insertRows(two.doc, [newDevice(two.doc, "f")], "a"))).toBe(true);
    expect(two.submit(settingsChange(two.doc, { notify: false }))).toBe(true);
    expect(two.submit(viewChange(two.doc, { textSize: 18 }))).toBe(true);
    expect(two.submit(columnVisibilityChange(two.doc, "best", true))).toBe(true);
    expect(two.submit(columnMoveChange(two.doc, "status", "enabled"))).toBe(true);
    expect(two.submit(resizeChange(two.doc, "column", "name", 220))).toBe(true);
    expect(two.submit(scaleChange(two.doc, 25))).toBe(true);
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
    expect(saved.view).toMatchObject({ span: "1h", textSize: 18, scaleMs: 25, bands: { green: 5, yellow: 20, orange: null } });
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
    one.submit(viewChange(one.doc, { span: "6h" }));
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
    one.submit(insertRows(one.doc, [newDevice(one.doc, "c")], null));
    await settled(module, [one, two]);
    // The second window changes the device the first window added, and adds one of its own.
    two.type([{ rowId: "c", columnId: "host", value: "10.0.0.60" }]);
    two.submit(insertRows(two.doc, [newDevice(two.doc, "d")], null));
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
    one.submit(insertRows(one.doc, [newDevice(one.doc, "c")], null));
    await settled(module, [one]);
    // The other two still show the old list and only change the layout.
    expect(two.submit(viewChange(two.doc, { span: "24h" }))).toBe(true);
    expect(two.submit(hideColumnChange(two.doc, "jitter"))).toBe(true);
    expect(three.submit(viewChange(three.doc, { textSize: 11 }))).toBe(true);
    expect(three.submit(resizeChange(three.doc, "row", "a", 48))).toBe(true);
    expect(three.submit(openSheetChange(three.doc, "devices"))).toBe(true); // already open: nothing to save
    for (const copy of [two, three]) copy.release();
    await settled(module, [one, two, three]);
    const saved = module.saved();
    expect(valueOf(saved.devices[0]!, "host")).toBe("10.0.0.100");
    expect(saved.settings.alertOverMs).toBe(50);
    expect(saved.devices.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(saved.view).toMatchObject({ span: "24h", textSize: 11, rowHeights: { a: 48 } });
    expect(saved.view.hidden).toContain("jitter");
    expect([...one.errors, ...two.errors, ...three.errors]).toEqual([]);
  });

  it("shares the open sheet: a sheet opened in one window opens in the others, and is never refused", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.submit(addSheet(one.doc, "cams", "Cameras"));
    await settled(module, [one, two]);
    expect(openSheetId(two.doc)).toBe("cams");
    two.hold();
    one.submit(renameSheet(one.doc, "cams", "Cams")!);
    await settled(module, [one]);
    // The second window switches back to Devices from its older copy of the sheets.
    expect(two.submit(openSheetChange(two.doc, "devices"), false)).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(openSheetId(one.doc)).toBe("devices");
    expect(sheetsOf(module.saved()).map((sheet) => sheet.name)).toEqual(["Devices", "Cams"]);
    expect([...one.errors, ...two.errors]).toEqual([]);
  });

  it("counts another window's new devices toward a Devices box number, and never takes them off", async () => {
    const module = await runModule([device("a", "Router", "10.0.0.1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(insertRows(one.doc, [newDevice(one.doc, "b")], null));
    await settled(module, [one]);
    // The second window still counts one device and asks for three.
    const { removed: _none, ...grow } = setDeviceCount(two.doc, 3, (() => { let n = 0; return () => `new-${++n}`; })())!;
    expect(two.submit(grow)).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(sheetRows(module.saved())).toHaveLength(3);
    expect(module.saved().devices.map((row) => row.id)).toEqual(["a", "b", "new-1"]);
    // Asking for one takes off only what that window was shown; nothing it never saw goes.
    two.hold();
    one.submit(insertRows(one.doc, [newDevice(one.doc, "c")], null));
    await settled(module, [one]);
    const { removed, ...shrink } = setDeviceCount(two.doc, 1, () => "unused")!;
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
    one!.submit(insertRows(one!.doc, [newDevice(one!.doc, "d")], null));
    two!.submit(insertRows(two!.doc, [newDevice(two!.doc, "e")], null));
    three!.submit(viewChange(three!.doc, { span: "1m" }));
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
    one.submit(insertRows(one.doc, [newDevice(one.doc, "a")], null));
    await settled(module, [one]);
    await until(() => states.some((state) => revisionIn(state) === module.revision()), "the state carried the new revision");
    stop();
  });
});
