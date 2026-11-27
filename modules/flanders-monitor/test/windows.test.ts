/**
 * The Flanders page open in two or three HubDash windows at once, all on one running module.
 *
 * Each copy is the page's own code: Hubble's page client (createModuleFrontendClient) on a channel
 * of its own, the monitor list as the page opens it (openMonitorList: DraftStore and followSaved),
 * and the page's own change builders (changes.ts and model.ts). The host side of each channel does
 * what Hubble does: it passes page commands to the one worker and hands every copy the worker's
 * state when it publishes. The worker has a fake document store; the one key press goes to a
 * fake monitor on loopback. What only a browser can show, the cell being typed in, is checked in
 * tools/qa-windows.mjs against the real page.
 */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ModuleFrontendValueSchema, createModuleFrontendClient, type ModuleFrontendValue } from "@hubble/module-sdk/frontend";
import type { ModuleContext } from "@hubble/module-sdk";
import { createBackend, type Statuses } from "../src/backend.js";
import { cellEdits, resizeChange, textSizeChange } from "../src/changes.js";
import { defaultDocument, DOCUMENT_ID, insertRows, moveRows, newMonitor, removeRows, valueOf, type MonitorDocument, type MonitorRow, type Mutation } from "../src/model.js";
import { openMonitorList, revisionIn } from "../src/page-store.js";
import source from "../src/manifest.js";
import { FakeMonitor } from "./fake-monitor.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(check: () => boolean, what: string, tries = 400) {
  for (let i = 0; i < tries && !check(); i++) await delay(5);
  expect(check(), what).toBe(true);
}
const monitor = (id: string, name: string, host = "10.0.0.5", values: Record<string, string> = {}): MonitorRow => ({
  id,
  values: { name, enabled: "TRUE", host, port: "18181", whenInUse: "send", ...values },
});

/** The one running Flanders module: the real worker and Hubble's document store as a fake. */
async function runModule(monitors: MonitorRow[]) {
  let saved = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: { ...defaultDocument(), monitors } as MonitorDocument };
  let revisions = 1;
  let writes = 0;
  let conflicts = 0;
  const watchers = new Set<() => void>();
  const services = {
    async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: MonitorDocument }, signal?: AbortSignal) {
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
  const pages = new Set<(state: unknown) => void>();
  const context = {
    connectionEnabled: true,
    instanceId: "flanders-windows",
    scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "flanders-monitor" },
    settings: {},
    services,
    log: () => undefined,
    publishState: (state: unknown) => {
      for (const push of pages) push(state);
    },
    publishFeedback: () => undefined,
  } as unknown as ModuleContext;
  // Nothing else is connected to the fake monitor, so the in-use check needs no connection table.
  const instance = createBackend(context, { listConnections: async () => [] });
  await instance.start!();
  cleanup.push(() => instance.dispose());
  const section = source.pages![0]!.sections[0]!;
  const declared = new Set(section.type === "custom" ? section.commands!.map((command) => command.id) : []);
  return {
    instance,
    pages,
    declared,
    saved: () => saved.value,
    revision: () => saved.revision,
    writes: () => writes,
    /** Saves the store turned away because another had landed first. */
    conflicts: () => conflicts,
    press: (name: string, key: string) =>
      instance.execute(
        "matrix",
        { actionId: "a", actionColumnId: "c", values: { enabled: true, "module.monitor": name, "module.key": key } },
        { executionId: "x", signal: new AbortController().signal, gesture: "press", wrap: false, log: () => undefined } as never,
      ),
  };
}
type Module = Awaited<ReturnType<typeof runModule>>;

/** One copy of the page in a window of its own. `hold()` keeps the worker's state from it until `release()`. */
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
        const value = await module.instance.call!("page.flanders", { sectionId: "frontend", commandId: request.commandId, value: request.value } as never, { signal: new AbortController().signal, log() {} } as never);
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
  const list = await openMonitorList(client);
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
    /** One status update, as the page's follow loop asks for it: its revision reaches followSaved too. */
    async changes(after = 0) {
      const reply = (await client.call("changes", { after } as ModuleFrontendValue)) as unknown as { statuses: Statuses; sequence: number; revision: unknown };
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

async function settled(module: Module, copies: Copy[], what = "every copy holds the list as saved") {
  await until(() => copies.every((copy) => !copy.store.pending.length && copy.store.revision === module.revision()), what);
  for (const copy of copies) expect(copy.doc).toEqual(module.saved());
}

describe("the Flanders page in several windows", () => {
  it("follows what another window saves, without a reload", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two, three] = [await openWindow(module), await openWindow(module), await openWindow(module)];
    one.submit(insertRows(one.doc, [newMonitor(one.doc, "b")], null));
    one.type([{ rowId: "b", columnId: "host", value: "10.0.0.6" }]);
    two.type([{ rowId: "a", columnId: "whenInUse", value: "wait" }]);
    three.submit(textSizeChange(three.doc, 16));
    await settled(module, [one, two, three]);
    for (const copy of [one, two, three]) {
      expect(copy.doc.monitors.map((row) => valueOf(row, "host"))).toEqual(["10.0.0.5", "10.0.0.6"]);
      expect(valueOf(copy.doc.monitors[0]!, "whenInUse")).toBe("wait");
      expect(copy.doc.view.textSize).toBe(16);
      expect(copy.errors).toEqual([]);
    }
  });

  it("hears of a save from a status update too, when Hubble's state is slow to come", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.type([{ rowId: "a", columnId: "name", value: "Grade A" }]);
    await settled(module, [one], "the first copy saved");
    expect(valueOf(two.doc.monitors[0]!, "name")).toBe("Grade 1");
    await two.changes();
    await until(() => valueOf(two.doc.monitors[0]!, "name") === "Grade A", "the status update's revision brought the list");
  });

  it("never refuses a copy for being behind, and keeps every window's changes", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2"), monitor("c", "Client")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(insertRows(one.doc, [newMonitor(one.doc, "d")], null)); // Monitor 4
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.9" }]);
    one.submit(resizeChange(one.doc, "column", "host", 200));
    one.submit(textSizeChange(one.doc, 15));
    await settled(module, [one], "the first window saved everything");

    expect(two.doc.monitors).toHaveLength(3);
    expect(two.submit(insertRows(two.doc, [newMonitor(two.doc, "e")], null))).toBe(true); // also "Monitor 4" here
    expect(two.type([{ rowId: "b", columnId: "port", value: "18182" }])).toBe(true);
    expect(two.submit(moveRows(two.doc, ["c"], "b"))).toBe(true);
    expect(two.submit(insertRows(two.doc, [newMonitor(two.doc, "f")], "a"))).toBe(true);
    expect(two.submit(removeRows(two.doc, ["e"]))).toBe(true);
    expect(two.submit(resizeChange(two.doc, "column", "name", 220))).toBe(true);
    expect(two.submit(resizeChange(two.doc, "row", "a", 44))).toBe(true);
    two.release();
    await settled(module, [one, two]);

    const saved = module.saved();
    expect([...one.errors, ...two.errors]).toEqual([]);
    expect(saved.monitors.map((row) => row.id)).toEqual(["f", "a", "c", "b", "d"]);
    // The second window's new monitors took the next free names: Monitor 4 was the first window's,
    // and Monitor 5 its own other new one until it was removed.
    expect(saved.monitors.map((row) => valueOf(row, "name"))).toEqual(["Monitor 6", "Grade 1", "Client", "Grade 2", "Monitor 4"]);
    expect(valueOf(saved.monitors[1]!, "host")).toBe("10.0.0.9");
    expect(valueOf(saved.monitors[3]!, "port")).toBe("18182");
    expect(saved.view).toEqual({ textSize: 15, widths: { host: 200, name: 220 }, rowHeights: { a: 44 } });
    expect(two.clashes).toEqual([]);
  });

  it("keeps what was typed last when two windows change the same cell, and says so in that window", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    // The second window opens the cell's editor over 18181, as the grid does.
    const expected = valueOf(two.doc.monitors[0]!, "port");
    one.type([{ rowId: "a", columnId: "port", value: "18190" }]);
    await settled(module, [one, two], "the second window followed while its editor was open");
    two.type([{ rowId: "a", columnId: "port", value: "18195" }], expected);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().monitors[0]!, "port")).toBe("18195");
    expect(two.clashes).toEqual(["Grade 1's Port"]);
    expect([...one.clashes, ...one.errors, ...two.errors]).toEqual([]);
  });

  it("keeps a red draft in its cell while other windows save", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    expect(two.type([{ rowId: "a", columnId: "port", value: "99999" }])).toBe(false);
    one.type([{ rowId: "b", columnId: "name", value: "Grade B" }]);
    one.submit(textSizeChange(one.doc, 17));
    await settled(module, [one, two]);
    expect(two.store.invalid.get("a/port")?.edit.value).toBe("99999");
  });

  it("puts back only a refused change, and the window then holds the list as saved", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.submit(removeRows(one.doc, ["b"]));
    await settled(module, [one]);
    two.type([{ rowId: "b", columnId: "host", value: "10.0.0.8" }]);
    two.type([{ rowId: "a", columnId: "name", value: "Grade A" }]);
    await until(() => !two.store.pending.length, "the second window's saves were answered");
    expect(two.errors).toEqual(["That monitor was removed before the change saved."]);
    await until(() => two.store.revision === module.revision(), "the refused window read the list again");
    expect(two.doc).toEqual(module.saved());
    expect(two.doc.monitors.map((row) => valueOf(row, "name"))).toEqual(["Grade A"]);
    expect(two.store.invalid.size).toBe(0);
    expect(two.type([{ rowId: "a", columnId: "port", value: "18200" }])).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(two.errors).toHaveLength(1);
  });

  it("doesn't report a clash for an edit made over a value that was refused here", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.type([{ rowId: "b", columnId: "name", value: "Client" }]);
    await settled(module, [one]);
    expect(two.type([{ rowId: "a", columnId: "name", value: "Client" }])).toBe(true);
    expect(two.type([{ rowId: "a", columnId: "name", value: "Client 2" }])).toBe(true);
    two.release();
    await settled(module, [one, two]);
    expect(two.errors).toEqual(["Another monitor is already called Client. Buttons pick monitors by name."]);
    expect(module.saved().monitors.map((row) => valueOf(row, "name"))).toEqual(["Client 2", "Client"]);
    expect(two.clashes).toEqual([]);
  });

  it("undoes only this window's change, and never another window's", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.submit(insertRows(one.doc, [newMonitor(one.doc, "b")], null));
    one.type([{ rowId: "a", columnId: "port", value: "18190" }]);
    await settled(module, [one, two]);
    two.type([{ rowId: "b", columnId: "host", value: "10.0.0.20" }]);
    await settled(module, [one, two]);
    // Undo the port: only the first window's value goes back.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(valueOf(module.saved().monitors[0]!, "port")).toBe("18181");
    // Undo the new monitor: the second window has filled it in since, so it stays.
    one.store.history(false);
    await settled(module, [one, two]);
    expect(module.saved().monitors.map((row) => row.id)).toEqual(["a", "b"]);
    expect(one.errors.at(-1)).toBe("Monitor 2 was changed in another window since, so it was left as it is.");
    expect(one.store.undo).toEqual([]);
  });

  it("refuses an Undo the worker finds another window has overtaken, and takes it off the Redo list", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    one.type([{ rowId: "a", columnId: "port", value: "18190" }]);
    await settled(module, [one, two]);
    one.hold();
    two.type([{ rowId: "a", columnId: "port", value: "18191" }]);
    await settled(module, [two]);
    // The first window hasn't heard, so its Undo looks fine to it, and the worker refuses it.
    one.store.history(false);
    await until(() => !one.store.pending.length, "the Undo was answered");
    expect(one.errors.at(-1)).toBe("Grade 1's Port was changed in another window since, so it was left as it is.");
    expect(one.store.redo).toEqual([]);
    expect(one.store.undo).toEqual([]);
    // It reads the list again at once, without hearing from Hubble.
    await until(() => one.store.revision === module.revision(), "the refused window read the list again");
    expect(valueOf(one.doc.monitors[0]!, "port")).toBe("18191");
  });

  it("never refuses a layout change, and a layout change never undoes an edit", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2")]);
    const [one, two, three] = [await openWindow(module), await openWindow(module), await openWindow(module)];
    for (const copy of [two, three]) copy.hold();
    one.type([{ rowId: "a", columnId: "host", value: "10.0.0.100" }]);
    one.submit(insertRows(one.doc, [newMonitor(one.doc, "c")], null));
    one.submit(resizeChange(one.doc, "column", "status", 300));
    await settled(module, [one]);
    expect(two.submit(textSizeChange(two.doc, 11))).toBe(true);
    expect(three.submit(resizeChange(three.doc, "column", "port", 120))).toBe(true);
    for (const copy of [two, three]) copy.release();
    await settled(module, [one, two, three]);
    const saved = module.saved();
    expect(valueOf(saved.monitors[0]!, "host")).toBe("10.0.0.100");
    expect(saved.monitors.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(saved.view).toEqual({ textSize: 11, widths: { status: 300, port: 120 }, rowHeights: {} });
    expect([...one.errors, ...two.errors, ...three.errors]).toEqual([]);
  });

  it("takes three windows saving at once, each change once, and then saves nothing more", async () => {
    const module = await runModule([monitor("a", "Grade 1"), monitor("b", "Grade 2"), monitor("c", "Client")]);
    const copies = [await openWindow(module), await openWindow(module), await openWindow(module)];
    const [one, two, three] = copies;
    const before = module.writes();
    one!.type([{ rowId: "a", columnId: "port", value: "18191" }]);
    two!.type([{ rowId: "b", columnId: "port", value: "18192" }]);
    three!.type([{ rowId: "c", columnId: "port", value: "18193" }]);
    one!.submit(insertRows(one!.doc, [newMonitor(one!.doc, "d")], null));
    two!.submit(insertRows(two!.doc, [newMonitor(two!.doc, "e")], null));
    three!.submit(textSizeChange(three!.doc, 14));
    await settled(module, copies);
    expect(module.writes() - before).toBe(6);
    // The worker saves one change at a time, so the windows never collide in the store.
    expect(module.conflicts()).toBe(0);
    expect(module.saved().monitors.map((row) => valueOf(row, "port"))).toEqual(["18191", "18192", "18193", "18181", "18181"]);
    expect(module.saved().monitors.map((row) => valueOf(row, "name"))).toEqual(["Grade 1", "Grade 2", "Client", "Monitor 4", "Monitor 5"]);
    expect(copies.flatMap((copy) => copy.errors)).toEqual([]);
    await delay(300);
    expect(module.writes() - before).toBe(6);
  });

  it("writes nothing when a window saves what another window already saved", async () => {
    const module = await runModule([monitor("a", "Grade 1")]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    two.hold();
    one.type([{ rowId: "a", columnId: "enabled", value: "FALSE" }]);
    await settled(module, [one]);
    const before = module.writes();
    two.type([{ rowId: "a", columnId: "enabled", value: "FALSE" }]);
    two.release();
    await settled(module, [one, two]);
    expect(module.writes()).toBe(before);
    expect([...one.errors, ...two.errors, ...two.clashes]).toEqual([]);
  });

  it("shows a key's result in every window, with the list's revision", async () => {
    const fake = new FakeMonitor("many");
    const port = await fake.listen();
    cleanup.push(() => fake.close());
    const module = await runModule([monitor("a", "Grade 1", "127.0.0.1", { port: String(port) })]);
    const [one, two] = [await openWindow(module), await openWindow(module)];
    const waiting = [one.changes(Date.now() + 1), two.changes(Date.now() + 1)];
    expect(await module.press("Grade 1", "f1")).toMatchObject({ status: "success" });
    for (const reply of await Promise.all(waiting)) {
      expect(reply.statuses.a?.text).toMatch(/^Sent F1 · /u);
      expect(reply.revision).toBe(module.revision());
    }
    expect(fake.keys).toEqual([0x31]);
  });

  it("keeps the worker's revision in its state for every copy to follow", async () => {
    const module = await runModule([]);
    const one = await openWindow(module);
    const states: unknown[] = [];
    const stop = one.client.subscribe((state) => states.push(state));
    one.submit(insertRows(one.doc, [newMonitor(one.doc, "a")], null));
    await settled(module, [one]);
    await until(() => states.some((state) => revisionIn(state) === module.revision()), "the state carried the new revision");
    stop();
  });
});
