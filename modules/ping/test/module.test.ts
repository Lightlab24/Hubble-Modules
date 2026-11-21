import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ModuleDocumentValueSchema, ModuleManifestSchema, type ModuleContext } from "@hubble/module-sdk";
import { createBackend, type BackendOptions, type LiveReply } from "../src/backend.js";
import { findFping, parsePingLine, pingArguments, Pinger, type PingProcess, type PingSample } from "../src/engine.js";
import { History } from "../src/history.js";
import source from "../src/manifest.js";
import { addSheet, moveRowsToSheet, moveSheet, openSheetId, removeSheet, renameSheet, sheetOf, sheetRows, sheetsOf, applyMutation, bytesPerSecond, colorFor, colorsOf, defaultDocument, PING_COLORS, roundScale, scaleStep, stepScale, DOCUMENT_ID, deviceHasData, formatRate, insertRows, inverse, newDevice, normalizeValue, rulesOf, ruleText, setDeviceCount, validateDocument, validateValue, type DeviceRow, type Mutation, type PingDocument } from "../src/model.js";
import { DeviceWatch } from "../src/watch.js";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(check: () => boolean, what: string, tries = 500) {
  for (let i = 0; i < tries && !check(); i++) await delay(10);
  expect(check(), what).toBe(true);
}
const row = (id: string, name: string, host: string, values: Record<string, string> = {}): DeviceRow => ({
  id,
  values: { name, enabled: "TRUE", host, over: "", lost: "", ...values },
});

/** Hubble's document store as the worker sees it: revisions, conflicts and a watch that wakes on the next write. */
function documentStore(initial: PingDocument) {
  let document = { id: DOCUMENT_ID, version: 1, revision: "rev-1", value: structuredClone(initial) };
  let writes = 1;
  const watchers = new Set<() => void>();
  const store = (value: PingDocument) => {
    document = { ...document, revision: `rev-${++writes}`, value: structuredClone(value) };
    for (const wake of [...watchers]) wake();
  };
  const services = {
    async request(_service: string, _version: number, input: { method: string; afterRevision?: string; expectedRevision?: string; value?: PingDocument }, signal?: AbortSignal) {
      if (input.method === "watch" && input.afterRevision === document.revision)
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
        if (input.expectedRevision !== document.revision) return { status: "conflict", document };
        store(input.value!);
      }
      return { status: "document", document };
    },
  };
  return { services, saved: () => document.value, writeFromElsewhere: store };
}

/** A stand-in for fping that the test feeds lines to. */
function fakePing() {
  const runs: { args: readonly string[]; killed: boolean; say(line: string): void; exit(): void }[] = [];
  const start = (args: readonly string[]): PingProcess => {
    const listeners: { data?: (chunk: string) => void; exit?: (code: number | null) => void } = {};
    const run = { args, killed: false, say: (line: string) => listeners.data?.(`${line}\n`), exit: () => listeners.exit?.(1) };
    runs.push(run);
    return {
      stdout: { on: (_event, listener) => (listeners.data = listener as (chunk: string) => void) },
      on(event: string, listener: never) {
        if (event === "exit") listeners.exit = listener;
        return this;
      },
      kill: () => (run.killed = true),
    } as PingProcess;
  };
  return { runs, start, current: () => runs.at(-1)! };
}
const answer = (address: string, seconds: number, ms: number) => `[${seconds.toFixed(5)}] ${address} : [0], 64 bytes, ${ms} ms (${ms} avg, 0% loss)`;
const timeout = (address: string, seconds: number) => `[${seconds.toFixed(5)}] ${address} : [0], timed out (NaN avg, 100% loss)`;

function backend(devices: DeviceRow[], options: BackendOptions & { connectionEnabled?: boolean; settings?: Partial<PingDocument["settings"]> } = {}) {
  const initial = defaultDocument();
  initial.devices = devices;
  Object.assign(initial.settings, options.settings);
  const documents = documentStore(initial);
  const states: { values: { online: number; alerts: number; checked: number } }[] = [];
  const feedback: { fields: unknown; state: string; appearance: { triggers: string[] | null } }[] = [];
  const logs: { level: string; stage: string; message: string }[] = [];
  const alerts: { channel: string; value: { key: string; title: string; body: string; severity: string; notification: boolean; dockBounce: boolean } }[] = [];
  const context = {
    connectionEnabled: options.connectionEnabled ?? true,
    instanceId: "ping-test",
    scope: { kind: "host", workspaceId: "11111111-1111-4111-8111-111111111111", capabilityId: "network-ping" },
    settings: {},
    services: documents.services,
    log: (trace: never) => logs.push(trace),
    publishState: (state: never) => states.push(state),
    publishFeedback: (value: never) => feedback.push(value),
    publishEvent: (channel: string, value: never) => alerts.push({ channel, value }),
  } as unknown as ModuleContext;
  const instance = createBackend(context, { liveWaitMs: 300, ...options });
  cleanup.push(() => instance.dispose());
  const call = <T>(commandId: string, value?: unknown) =>
    instance.call!(`page.ping`, { sectionId: "frontend", commandId, value } as never, { signal: new AbortController().signal } as never) as unknown as Promise<T>;
  return { instance, documents, states, feedback, logs, alerts, call, live: (value: object = {}) => call<LiveReply>("live", value) };
}

describe("the manifest", () => {
  it("is a valid workspace module with one full page", () => {
    const manifest = ModuleManifestSchema.parse({ ...source, id: "network-ping", name: "Ping", version: "0.1.8", entry: "module.mjs", files: ["module.mjs", "ui/index.html", "ui/app.js", "ui/ping.svg"] });
    expect(manifest.instanceScope).toBe("workspace");
    expect(manifest.pages?.[0]?.layout).toBe("full-page");
    expect(manifest.matrix?.triggers?.map((trigger) => trigger.id)).toEqual(["offline", "slow", "online"]);
  });
});

describe("the saved device list", () => {
  it("checks each cell and keeps the typed alert time as a number of ms", () => {
    expect(validateValue("host", "10.192.4.31")).toBeUndefined();
    expect(validateValue("host", "10.192.4.999")).toMatch(/IPv4/u);
    expect(validateValue("host", "truck-b.local")).toMatch(/IPv4/u);
    expect(normalizeValue("over", "80 ms")).toBe("80");
    expect(normalizeValue("over", " 80ms ")).toBe("80");
    expect(validateValue("over", normalizeValue("over", "fast"))).toMatch(/1 to 60000/u);
    expect(validateValue("over", "")).toBeUndefined();
    // Alert When Lost For is a time in seconds; Off never alerts and empty follows the global setting.
    expect(normalizeValue("lost", "5 s")).toBe("5");
    expect(normalizeValue("lost", "Never")).toBe("off");
    expect(normalizeValue("over", "OFF")).toBe("off");
    expect(validateValue("lost", "5")).toBeUndefined();
    expect(validateValue("lost", "off")).toBeUndefined();
    expect(validateValue("lost", "")).toBeUndefined();
    expect(validateValue("lost", normalizeValue("lost", "soon"))).toMatch(/1 to 3600 seconds/u);
    expect(validateValue("lost", "4000")).toMatch(/1 to 3600 seconds/u);
  });

  it("refuses two devices with one name, and undoes an edit exactly", () => {
    const doc = defaultDocument();
    doc.devices = [row("a", "Router", "10.0.0.1"), row("b", "RCP 1", "10.0.0.2")];
    expect(() => applyMutation(doc, { kind: "edit", edits: [{ rowId: "b", columnId: "name", value: "router", expected: "RCP 1" }] })).toThrow(/already called/u);
    const edit: Mutation = { kind: "edit", edits: [{ rowId: "b", columnId: "over", value: "50", expected: "" }] };
    const after = applyMutation(doc, edit);
    expect(after.devices[1]!.values.over).toBe("50");
    expect(applyMutation(after, inverse(doc, edit))).toEqual(doc);
    const added = newDevice(doc, "c");
    expect(added.values.name).toBe("Device 3");
    expect(applyMutation(doc, insertRows(doc, [added], "b")).devices.map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("uses a device's own alert cells where they say something and the global settings where they don't", () => {
    const settings = { ...defaultDocument().settings, alertOverMs: 80, alertLostMs: 3000 };
    expect(rulesOf(row("a", "Router", "10.0.0.1"), settings)).toEqual({ overMs: 80, lostMs: 3000 });
    expect(rulesOf(row("a", "Router", "10.0.0.1", { over: "20", lost: "10" }), settings)).toEqual({ overMs: 20, lostMs: 10_000 });
    expect(rulesOf(row("a", "Router", "10.0.0.1", { over: "off", lost: "off" }), settings)).toEqual({ overMs: null, lostMs: null });
    expect(rulesOf(row("a", "Router", "10.0.0.1"), { ...settings, alertOverMs: null, alertLostMs: null })).toEqual({ overMs: null, lostMs: null });
    // What the cell shows: its own value, or the global one it follows.
    expect(ruleText("over", "", settings)).toEqual({ text: "80 ms", inherited: true });
    expect(ruleText("lost", "", settings)).toEqual({ text: "3 s", inherited: true });
    expect(ruleText("lost", "90", settings)).toEqual({ text: "1.5 min", inherited: false });
    expect(ruleText("over", "off", settings)).toEqual({ text: "Off", inherited: false });
    expect(ruleText("over", "", { ...settings, alertOverMs: null })).toEqual({ text: "Off", inherited: true });
  });

  it("sets the number of devices: blank rows added at the end, or the last rows taken off, in one undo step", () => {
    const doc = defaultDocument();
    doc.devices = [row("a", "Router", "10.0.0.1"), row("b", "Device 2", "")];
    let next = 0;
    const grow = setDeviceCount(doc, 5, () => `new-${++next}`)!;
    expect(grow.removed).toEqual([]);
    const grown = applyMutation(doc, { kind: grow.kind, rows: grow.rows, expected: grow.expected });
    // "Device 2" is taken, so the new names step past it and stay unique.
    expect(grown.devices.map((item) => item.values.name)).toEqual(["Router", "Device 2", "Device 3", "Device 4", "Device 5"]);
    expect(grown.devices.slice(2).every((item) => item.values.host === "" && item.values.enabled === "TRUE")).toBe(true);
    expect(applyMutation(grown, inverse(doc, { kind: grow.kind, rows: grow.rows, expected: grow.expected }))).toEqual(doc);
    const shrink = setDeviceCount(grown, 1, () => "x")!;
    expect(shrink.rows.map((item) => item.id)).toEqual(["a"]);
    expect(shrink.removed.map((item) => item.id)).toEqual(["b", "new-1", "new-2", "new-3"]);
    expect(setDeviceCount(doc, 2, () => "x"), "the same number changes nothing").toBeNull();
    expect(() => setDeviceCount(doc, 129, () => "x")).toThrow("Use from 0 to 128 devices.");
    expect(() => setDeviceCount(doc, 2.5, () => "x")).toThrow("Use from 0 to 128 devices.");
    expect(() => setDeviceCount(doc, NaN, () => "x")).toThrow("Use from 0 to 128 devices.");
    // Only a row with something filled in is worth asking about before it goes.
    expect(deviceHasData(row("b", "Device 2", ""))).toBe(false);
    expect(deviceHasData(row("a", "Router", ""))).toBe(true);
    expect(deviceHasData(row("b", "Device 2", "10.0.0.2"))).toBe(true);
    expect(deviceHasData(row("b", "Device 2", "", { over: "80" }))).toBe(true);
    expect(deviceHasData(row("b", "Device 2", "", { enabled: "FALSE" }))).toBe(true);
  });

  it("rejects a ping time or size that isn't on the list", () => {
    const doc = defaultDocument();
    expect(() => validateDocument({ ...doc, settings: { ...doc.settings, intervalMs: 50 } })).toThrow(/ping time/u);
    expect(() => validateDocument({ ...doc, settings: { ...doc.settings, sizeBytes: 9000 } })).toThrow(/ping size/u);
  });

  it("saves the timeline scale with the page, and Auto as no scale at all", () => {
    const doc = defaultDocument();
    expect(doc.view.scaleMs).toBeUndefined();
    const set: Mutation = { kind: "view", view: { ...structuredClone(doc.view), scaleMs: 2 }, expected: structuredClone(doc.view) };
    const scaled = applyMutation(doc, set);
    expect(scaled.view.scaleMs).toBe(2);
    expect(() => validateDocument(scaled)).not.toThrow();
    // Undo takes it back to Auto, which a document without the field reads as.
    expect(applyMutation(scaled, inverse(doc, set)).view.scaleMs).toBeUndefined();
    // Any scale in range is allowed, not only round ones.
    expect(() => validateDocument({ ...doc, view: { ...doc.view, scaleMs: 2.5 } })).not.toThrow();
    expect(() => validateDocument({ ...doc, view: { ...doc.view, scaleMs: 0 } })).toThrow(/timeline scale/u);
    expect(() => validateDocument({ ...doc, view: { ...doc.view, scaleMs: 20_000 } })).toThrow(/timeline scale/u);
    expect(() => validateDocument({ ...doc, view: { ...doc.view, scaleMs: Number.NaN } })).toThrow(/timeline scale/u);
  });

  it("rounds a dragged scale and steps − and + by about a tenth of it", () => {
    expect(roundScale(2.4637)).toBe(2.46);
    expect(roundScale(37.21)).toBe(37.2);
    expect(roundScale(0.01)).toBe(0.1);
    expect(roundScale(99_999)).toBe(10_000);
    expect(scaleStep(2.5)).toBe(0.5);
    expect(scaleStep(40)).toBe(5);
    expect(scaleStep(1)).toBe(0.1);
    expect(scaleStep(300)).toBe(50);
    // − and + land on round numbers from wherever the scale is.
    expect(stepScale(2.37, 1)).toBe(2.5);
    expect(stepScale(2.37, -1)).toBe(2);
    expect(stepScale(2.5, -1)).toBe(2);
    expect(stepScale(40, 1)).toBe(45);
    expect(stepScale(0.1, -1)).toBe(0.1);
  });

  it("colours bars green, yellow, orange and red by the user's times, or by the alert limit until there are any", () => {
    // Without the user's times, colours follow the alert limit as before.
    expect(colorsOf(undefined, 20)).toEqual({ bands: [{ upToMs: 20, color: PING_COLORS.ok }], over: PING_COLORS.warn, lost: PING_COLORS.bad });
    expect(colorFor(colorsOf(undefined, null), 900)).toBe(PING_COLORS.ok);
    const mine = { green: 1, yellow: 1.5, orange: 5 };
    const colors = colorsOf(mine, 20);
    expect(colorFor(colors, 0.4)).toBe(PING_COLORS.green);
    expect(colorFor(colors, 1)).toBe(PING_COLORS.green);
    expect(colorFor(colors, 1.2)).toBe(PING_COLORS.yellow);
    expect(colorFor(colors, 4)).toBe(PING_COLORS.orange);
    expect(colorFor(colors, 25)).toBe(PING_COLORS.red);
    expect(colors.lost).toBe(PING_COLORS.red);
    // An empty time leaves its colour out.
    expect(colorFor(colorsOf({ green: 1, yellow: null, orange: 5 }, null), 3)).toBe(PING_COLORS.orange);
    expect(colorFor(colorsOf({ green: 2, yellow: null, orange: null }, null), 3)).toBe(PING_COLORS.red);

    const doc = defaultDocument();
    const set: Mutation = { kind: "view", view: { ...structuredClone(doc.view), bands: mine }, expected: structuredClone(doc.view) };
    const coloured = applyMutation(doc, set);
    expect(() => validateDocument(coloured)).not.toThrow();
    expect(applyMutation(coloured, inverse(doc, set)).view.bands).toBeUndefined();
    const bad = (bands: unknown) => () => validateDocument({ ...doc, view: { ...doc.view, bands: bands as typeof mine } });
    expect(bad({ green: 2, yellow: 1, orange: 5 })).toThrow(/above the one before/u);
    expect(bad({ green: 0, yellow: null, orange: null })).toThrow(/0\.1 to 60000/u);
    expect(bad({ green: null, yellow: null, orange: null })).toThrow(/at least one/u);
    expect(() => validateDocument({ ...doc, view: { ...doc.view, bands: { green: null, yellow: 3, orange: null } } })).not.toThrow();
  });

  it("keeps devices on named sheets, and reads a list from before sheets as one sheet", () => {
    const device = (id: string, name: string, sheetId?: string): DeviceRow => ({ id, values: { name, enabled: "TRUE", host: "", over: "", lost: "" }, ...(sheetId ? { sheetId } : {}) });
    let doc: PingDocument = { ...defaultDocument(), devices: [device("a", "Router"), device("b", "Camera A"), device("c", "Camera B")] };
    // A document from 0.1.7 has no sheets: one, Devices, holds everything.
    expect(sheetsOf(doc)).toEqual([{ id: "devices", name: "Devices" }]);
    expect(sheetRows(doc).map((row) => row.id)).toEqual(["a", "b", "c"]);
    const apply = (operation: Mutation | null) => {
      const before = doc;
      doc = applyMutation(doc, operation!);
      return { before, operation: operation! };
    };

    // Adding a sheet opens it, empty; a new device lands on it.
    const added = apply(addSheet(doc, "cams", " Cameras "));
    expect(sheetsOf(doc).map((sheet) => sheet.name)).toEqual(["Devices", "Cameras"]);
    expect(openSheetId(doc)).toBe("cams");
    expect(sheetRows(doc)).toEqual([]);
    expect(newDevice(doc, "d").sheetId).toBe("cams");
    expect(() => addSheet(doc, "x", "cameras")).toThrow("There is already a sheet called cameras.");
    expect(() => addSheet(doc, "x", "  ")).toThrow("Give the sheet a name.");
    expect(applyMutation(doc, inverse(added.before, added.operation)).sheets).toEqual([{ id: "devices", name: "Devices" }]);
    expect(openSheetId(applyMutation(doc, inverse(added.before, added.operation)))).toBe("devices");

    // Moving devices keeps their place in the list; the Devices box counts only the open sheet.
    apply(moveRowsToSheet(doc, ["b", "c"], "cams"));
    expect(sheetRows(doc, "cams").map((row) => row.id)).toEqual(["b", "c"]);
    expect(sheetRows(doc, "devices").map((row) => row.id)).toEqual(["a"]);
    expect(moveRowsToSheet(doc, ["b"], "cams"), "already there").toBeNull();
    const grow = setDeviceCount(doc, 3, () => "e")!;
    expect(grow.rows.filter((row) => sheetOf({ ...doc, devices: grow.rows }, row) === "cams")).toHaveLength(3);
    expect(grow.rows.find((row) => row.id === "a")).toBeDefined();
    const shrink = setDeviceCount(doc, 1, () => "x")!;
    expect(shrink.removed.map((row) => row.id)).toEqual(["c"]);
    expect(shrink.rows.map((row) => row.id)).toEqual(["a", "b"]);

    // Rename and reorder.
    apply(renameSheet(doc, "cams", "Cameras on set"));
    expect(renameSheet(doc, "cams", "Cameras on set"), "same name").toBeNull();
    expect(() => renameSheet(doc, "cams", "devices")).toThrow("There is already a sheet called devices.");
    apply(moveSheet(doc, "cams", "devices"));
    expect(sheetsOf(doc).map((sheet) => sheet.id)).toEqual(["cams", "devices"]);
    // Router came from before sheets, with no sheet of its own; it stays on Devices when Cameras moves to the front.
    expect(sheetRows(doc, "devices").map((row) => row.id)).toEqual(["a"]);

    // The portable document an export carries keeps sheets, each device's sheet and the open sheet.
    const portable = validateDocument(JSON.parse(JSON.stringify(ModuleDocumentValueSchema.parse(doc))));
    expect(portable.sheets).toEqual(doc.sheets);
    expect(portable.devices.map((row) => row.sheetId)).toEqual(doc.devices.map((row) => row.sheetId));
    expect(portable.view.sheetId).toBe("cams");

    // Removing a sheet takes its devices; Undo brings both back. The last sheet stays.
    const removing = removeSheet(doc, "cams")!;
    expect(removing.removed.map((row) => row.id)).toEqual(["b", "c"]);
    const { removed: _gone, ...change } = removing;
    const removed = apply(change);
    expect(doc.devices.map((row) => row.id)).toEqual(["a"]);
    expect(openSheetId(doc)).toBe("devices");
    expect(removeSheet(doc, "devices"), "the last sheet stays").toBeNull();
    doc = applyMutation(doc, inverse(removed.before, removed.operation));
    expect(sheetRows(doc, "cams").map((row) => row.id)).toEqual(["b", "c"]);
    expect(openSheetId(doc)).toBe("cams");

    // A device that names a sheet that is gone, or none (as 0.1.7 adds them), is on the first sheet.
    expect(sheetOf(doc, device("z", "Old", "gone"))).toBe("cams");
    expect(sheetOf(doc, device("z", "Old"))).toBe("cams");
    // Names stay unique across sheets, because keys pick devices by name.
    expect(() => validateDocument({ ...doc, devices: [...doc.devices, device("z", "camera a", "devices")] })).toThrow(/already called/u);
    expect(() => validateDocument({ ...doc, sheets: [{ id: "a", name: "One" }, { id: "b", name: "one" }] })).toThrow(/already a sheet called one/u);
    expect(() => validateDocument({ ...doc, sheets: [] })).toThrow(/1 to 32 sheets/u);
  });

  it("works out the data Ping sends", () => {
    // 6 devices, 56 bytes plus 28 of headers, once a second: 504 bytes a second.
    expect(bytesPerSecond(6, { intervalMs: 1000, sizeBytes: 56, pinging: true, alertOverMs: null, alertLostMs: 3000, notify: true })).toBe(504);
    expect(formatRate(504)).toBe("4.0 kb/s");
    expect(bytesPerSecond(6, { intervalMs: 1000, sizeBytes: 56, pinging: false, alertOverMs: null, alertLostMs: 3000, notify: true })).toBe(0);
    expect(formatRate(bytesPerSecond(100, { intervalMs: 200, sizeBytes: 1400, pinging: true, alertOverMs: null, alertLostMs: 3000, notify: true }))).toBe("5.7 Mb/s");
  });
});

describe("reading fping", () => {
  it("reads an answer and a timeout, and ignores anything else", () => {
    expect(parsePingLine("[1795132193.81926] 127.0.0.1 : [0], 64 bytes, 0.211 ms (0.211 avg, 0% loss)")).toEqual({ address: "127.0.0.1", at: 1795132193819, rtt: 0.211 });
    expect(parsePingLine("[1795132194.12204] 192.0.2.1 : [0], timed out (NaN avg, 100% loss)")).toEqual({ address: "192.0.2.1", at: 1795132194122, rtt: null });
    expect(parsePingLine("127.0.0.1 : xmt/rcv/%loss = 4/4/0%, min/avg/max = 0.112/0.171/0.242")).toBeNull();
    expect(parsePingLine("")).toBeNull();
  });

  it("asks fping for the chosen time and size", () => {
    expect(pingArguments({ addresses: ["10.0.0.1", "10.0.0.2"], intervalMs: 500, sizeBytes: 1400 })).toEqual(["-l", "-D", "-p", "500", "-i", "1", "-b", "1400", "10.0.0.1", "10.0.0.2"]);
  });

  it("starts again with a new plan, stops for an empty one, and restarts after a crash", async () => {
    const fake = fakePing();
    const samples: PingSample[] = [];
    const problems: string[] = [];
    const pinger = new Pinger((sample) => samples.push(sample), (message) => problems.push(message), { start: fake.start, restartMs: 20 });
    cleanup.push(() => pinger.stop());
    pinger.configure({ addresses: ["10.0.0.2", "10.0.0.1", "10.0.0.1"], intervalMs: 1000, sizeBytes: 56 });
    expect(fake.runs).toHaveLength(1);
    expect(fake.current().args.slice(-2)).toEqual(["10.0.0.1", "10.0.0.2"]);
    pinger.configure({ addresses: ["10.0.0.1", "10.0.0.2"], intervalMs: 1000, sizeBytes: 56 });
    expect(fake.runs, "the same plan keeps the same process").toHaveLength(1);
    fake.current().say(answer("10.0.0.1", 100, 2.5));
    expect(samples).toEqual([{ address: "10.0.0.1", at: 100_000, rtt: 2.5 }]);
    pinger.configure({ addresses: ["10.0.0.1"], intervalMs: 200, sizeBytes: 56 });
    expect(fake.runs[0]!.killed).toBe(true);
    expect(fake.runs).toHaveLength(2);
    fake.runs[0]!.say(answer("10.0.0.2", 101, 9));
    expect(samples, "a line from the old process is ignored").toHaveLength(1);
    fake.current().exit();
    expect(problems.at(-1)).toMatch(/stopped unexpectedly/u);
    await until(() => fake.runs.length === 3, "pinging starts again");
    pinger.configure({ addresses: [], intervalMs: 200, sizeBytes: 56 });
    expect(fake.runs[2]!.killed).toBe(true);
    expect(fake.runs).toHaveLength(3);
  });
});

describe("history", () => {
  it("keeps totals for a span and cuts a stretch into bins", () => {
    const history = new History();
    const start = 1_800_000_000_000;
    for (let second = 0; second < 600; second++) history.add(start + second * 1000, second >= 300 && second < 310 ? null : second < 300 ? 10 : 30);
    const now = start + 599_000;
    const all = history.totals(start - 1000, now, now);
    expect(all.sent).toBe(600);
    expect(all.lost).toBe(10);
    expect(all.min).toBe(10);
    expect(all.max).toBe(30);
    const lastMinute = history.totals(now - 60_000, now, now);
    expect(lastMinute.sent).toBe(60);
    expect(lastMinute.sum / lastMinute.sent).toBe(30);
    const series = history.series(start - 10_000, start + 590_000, 60, now);
    expect(series.stepMs).toBe(10_000);
    expect(series.sent).toHaveLength(60);
    expect(series.avg[0]).toBe(10);
    expect(series.lost[30]).toBe(10);
    expect(series.avg[30]).toBeNull();
    expect(series.max[59]).toBe(30);
  });

  it("gives one bin per ping for fast pings, and never a bin finer than the ping time", () => {
    const history = new History();
    const start = 1_800_000_000_000;
    for (let index = 0; index < 300; index++) history.add(start + index * 200, index === 150 ? null : 5 + (index % 3));
    const now = start + 59_800;
    const fast = history.series(start - 200, now, 600, now, 200);
    expect(fast.stepMs).toBe(200);
    expect(fast.sent).toHaveLength(300);
    expect(fast.sent.every((count) => count === 1), "every bin holds exactly one ping, so no bar is missing").toBe(true);
    expect(fast.lost[150]).toBe(1);
    expect(fast.max[1]).toBe(6);
    // The same minute at a one-second ping time: bins are a second wide, however many points are asked for.
    const slow = history.series(start - 1000, now, 600, now, 1000);
    expect(slow.stepMs).toBe(1000);
    expect(slow.sent.every((count) => count === 5)).toBe(true);
  });

  it("answers for a day back from ten-second buckets, and forgets what is older", () => {
    const history = new History();
    const start = 1_800_000_000_000;
    const day = 86_400_000;
    for (let at = start; at < start + day + 3_600_000; at += 5000) history.add(at, 20);
    const now = start + day + 3_595_000;
    const series = history.series(now - day, now, 600, now);
    expect(series.stepMs).toBe(150_000);
    expect(series.sent.reduce((a, b) => a + b, 0)).toBeGreaterThan(17_000);
    // The first hour has been overwritten by the hour after the day.
    expect(history.totals(start, start + 1_800_000, now).sent).toBe(0);
  });
});

describe("a device's state", () => {
  const start = 1_800_000_000_000;
  const rules = (overMs: number | null, lostMs: number | null) => ({ overMs, lostMs });
  it("goes Offline once it hasn't answered for its lost time, alerts once, and says how long it was away", () => {
    const watch = new DeviceWatch("10.0.0.5");
    const lost3 = rules(null, 3000);
    expect(watch.add("RIO Truck B", lost3, start, 4)).toBeNull();
    expect(watch.state).toBe("online");
    expect(watch.add("RIO Truck B", lost3, start + 1000, null)).toBeNull();
    expect(watch.add("RIO Truck B", lost3, start + 2000, null)).toBeNull();
    expect(watch.state, "two seconds without an answer is not yet an alert").toBe("online");
    expect(watch.add("RIO Truck B", lost3, start + 3000, null)).toEqual({
      level: "error",
      stage: "device-offline",
      message: "RIO Truck B (10.0.0.5) stopped answering: no answer for 3 s",
      title: "RIO Truck B stopped answering",
      body: "10.0.0.5 · no answer for 3 s",
    });
    expect(watch.state).toBe("offline");
    expect(watch.add("RIO Truck B", lost3, start + 4000, null), "no second alert while it stays away").toBeNull();
    expect(watch.add("RIO Truck B", lost3, start + 45_000, 5)).toMatchObject({ level: "info", stage: "device-online", message: "RIO Truck B (10.0.0.5) is answering again after 42 s", title: "RIO Truck B is answering again after 42 s", body: "10.0.0.5" });
    expect(watch.state).toBe("online");
  });

  it("measures the lost time in seconds, not pings, so the ping time doesn't change when it alerts", () => {
    // Five pings a second, alert after two seconds: ten lost pings, not two.
    const fast = new DeviceWatch("10.0.0.5");
    fast.add("Fast", rules(null, 2000), start, 4);
    let alertedAt = 0;
    for (let index = 1; index <= 12 && !alertedAt; index++) if (fast.add("Fast", rules(null, 2000), start + index * 200, null)) alertedAt = index * 200;
    expect(alertedAt).toBe(2000);
    // One ping every five seconds, same two-second rule: the first lost ping is already past it.
    const slow = new DeviceWatch("10.0.0.5");
    slow.add("Slow", rules(null, 2000), start, 4);
    expect(slow.add("Slow", rules(null, 2000), start + 5000, null)?.message).toBe("Slow (10.0.0.5) stopped answering: no answer for 5 s");
  });

  it("takes the first state a device settles into as where it starts, without alerting", () => {
    // Already down when Ping starts, as after a restart: it reads Offline, and says nothing.
    const down = new DeviceWatch("10.0.0.6");
    for (const second of [0, 1, 2, 3]) expect(down.add("Down", rules(null, 2000), start + second * 1000, null)).toBeNull();
    expect(down.state).toBe("offline");
    // Coming back is a change, so that is announced.
    expect(down.add("Down", rules(null, 2000), start + 10_000, 4)?.message).toBe("Down (10.0.0.6) is answering again after 8 s");
    // And so is the next drop.
    expect(down.add("Down", rules(null, 2000), start + 11_000, null)).toBeNull();
    expect(down.add("Down", rules(null, 2000), start + 12_000, null)?.stage).toBe("device-offline");
    // Already slow when Ping starts: Slow, and silent. Getting back under the limit is announced.
    const slow = new DeviceWatch("10.0.0.7");
    expect(slow.add("Slow", rules(80, null), start, 140)).toBeNull();
    expect(slow.state).toBe("slow");
    for (const second of [1, 2]) expect(slow.add("Slow", rules(80, null), start + second * 1000, 20)).toBeNull();
    expect(slow.add("Slow", rules(80, null), start + 3000, 20)?.stage).toBe("device-online");
    // Up when Ping starts: Online, silent, and the first drop after it alerts as usual.
    const up = new DeviceWatch("10.0.0.8");
    expect(up.add("Up", rules(null, 2000), start, 4)).toBeNull();
    expect(up.state).toBe("online");
  });

  it("reads Offline without alerting when the lost alert is off", () => {
    const watch = new DeviceWatch("10.0.0.5");
    for (let i = 0; i < 5; i++) expect(watch.add("Spare", rules(null, null), start + i * 1000, null)).toBeNull();
    expect(watch.state).toBe("offline");
    expect(watch.add("Spare", rules(null, null), start + 6000, 3)).toBeNull();
    expect(watch.state).toBe("online");
  });

  it("goes Slow on the first answer over the limit and Online after three under it", () => {
    const watch = new DeviceWatch("10.0.0.5");
    const over80 = rules(80, 3000);
    watch.add("RIO Truck B", over80, start, 30);
    expect(watch.add("RIO Truck B", over80, start + 1000, 142)?.message).toBe("RIO Truck B (10.0.0.5) answered in 142 ms, over its 80 ms limit");
    expect(watch.state).toBe("slow");
    expect(watch.add("RIO Truck B", over80, start + 2000, 150), "no second alert while it stays slow").toBeNull();
    expect(watch.add("RIO Truck B", over80, start + 3000, 40)).toBeNull();
    expect(watch.add("RIO Truck B", over80, start + 4000, 120), "one answer over the limit starts the count again").toBeNull();
    expect(watch.add("RIO Truck B", over80, start + 5000, 40)).toBeNull();
    expect(watch.add("RIO Truck B", over80, start + 6000, 40)).toBeNull();
    expect(watch.state).toBe("slow");
    expect(watch.add("RIO Truck B", over80, start + 7000, 40)?.message).toBe("RIO Truck B (10.0.0.5) is back under its limit after 6 s");
    expect(watch.state).toBe("online");
  });

  it("summarises the chosen span", () => {
    const watch = new DeviceWatch("10.0.0.5");
    for (let second = 0; second < 100; second++) watch.add("RCP 1", rules(null, null), start + second * 1000, second % 10 === 9 ? null : second % 2 ? 6 : 4);
    const summary = watch.summary(60_000, start + 99_000);
    expect(summary.lostPct).toBe(10);
    expect(summary.best).toBe(4);
    expect(summary.worst).toBe(6);
    expect(summary.average).toBe(4.89);
    expect(summary.jitter).toBeGreaterThan(1);
    expect(summary.now).toBeNull();
    expect(summary.strip.sent.reduce((a, b) => a + b, 0)).toBe(60);
    expect(summary.strip.stepMs, "a strip never cuts finer than a second").toBe(1000);
  });
});

describe("the module", () => {
  it("pings the enabled devices with an address, at the saved time and size", async () => {
    const fake = fakePing();
    const { instance } = backend([row("a", "Router", "10.0.0.1"), row("b", "Spare", "10.0.0.2", { enabled: "FALSE" }), row("c", "New", "")], { start: fake.start, settings: { intervalMs: 500, sizeBytes: 128 } });
    await instance.start!();
    expect(fake.current().args).toEqual(["-l", "-D", "-p", "500", "-i", "1", "-b", "128", "10.0.0.1"]);
  });

  it("pings nothing while paused or while the module is switched off", async () => {
    const paused = fakePing();
    const first = backend([row("a", "Router", "10.0.0.1")], { start: paused.start, settings: { pinging: false } });
    await first.instance.start!();
    expect(paused.runs).toHaveLength(0);
    const off = fakePing();
    const second = backend([row("a", "Router", "10.0.0.1")], { start: off.start, connectionEnabled: false });
    await second.instance.start!();
    expect(off.runs).toHaveLength(0);
    expect((await second.live()).devices.a?.state).toBe("not-checked");
  });

  it("saves an edit, pings the new address and forgets the old one's results", async () => {
    const fake = fakePing();
    const { instance, call, live, documents } = backend([row("a", "Router", "10.0.0.1")], { start: fake.start, now: () => 100_500 });
    await instance.start!();
    fake.current().say(answer("10.0.0.1", 100, 3));
    expect((await live()).devices.a?.now).toBe(3);
    await call("save", { operation: { kind: "edit", edits: [{ rowId: "a", columnId: "host", value: "10.0.0.9", expected: "10.0.0.1" }] } });
    expect(documents.saved().devices[0]!.values.host).toBe("10.0.0.9");
    expect(fake.current().args.at(-1)).toBe("10.0.0.9");
    const after = await live();
    expect(after.devices.a?.now).toBeNull();
    expect(after.devices.a?.state).toBe("not-checked");
  });

  it("follows a change made somewhere else", async () => {
    const fake = fakePing();
    const { instance, documents } = backend([row("a", "Router", "10.0.0.1")], { start: fake.start });
    await instance.start!();
    const next = structuredClone(documents.saved());
    next.settings.intervalMs = 200;
    documents.writeFromElsewhere(next);
    await until(() => fake.current().args[3] === "200", "the new ping time is used");
  });

  it("logs a drop and a recovery, lights the device's keys, and counts alerts", async () => {
    const fake = fakePing();
    const { instance, logs, feedback, states, live } = backend([row("a", "RIO Truck B", "10.0.0.5", { lost: "2" }), row("b", "RCP 1", "10.0.0.6")], { start: fake.start, now: () => 110_000 });
    await instance.start!();
    const key = (device: string) => ({ id: "device", fields: { actionId: "row", actionColumnId: "column", values: { "module.device": device } } });
    instance.subscribeFeedback!([key("rio truck b"), key("Nobody")] as never, { signal: new AbortController().signal });
    expect(feedback.map((item) => item.state)).toEqual(["unavailable", "unavailable"]);
    fake.current().say(answer("10.0.0.5", 100, 4));
    fake.current().say(answer("10.0.0.6", 100, 2));
    expect(feedback.at(-1)).toMatchObject({ state: "active", appearance: { triggers: ["online"] } });
    fake.current().say(timeout("10.0.0.5", 101));
    expect(logs).toHaveLength(0);
    fake.current().say(timeout("10.0.0.5", 102));
    expect(logs).toEqual([{ level: "error", stage: "device-offline", message: "RIO Truck B (10.0.0.5) stopped answering: no answer for 2 s" }]);
    expect(feedback.at(-1)).toMatchObject({ state: "inactive", appearance: { triggers: ["offline"] } });
    expect(states.at(-1)!.values).toMatchObject({ online: 1, alerts: 1, checked: 2 });
    const reply = await live();
    expect(reply.devices.a?.state).toBe("offline");
    expect(reply.devices.b?.state).toBe("online");
    fake.current().say(answer("10.0.0.5", 108, 4));
    expect(logs.at(-1)).toMatchObject({ level: "info", message: "RIO Truck B (10.0.0.5) is answering again after 6 s" });
    expect(feedback.at(-1)).toMatchObject({ state: "active", appearance: { triggers: ["online"] } });
    expect(states.at(-1)!.values).toMatchObject({ online: 2, alerts: 0 });
    expect(feedback.filter((item) => (item.fields as { values: Record<string, string> }).values["module.device"] === "Nobody"), "a key naming no device stays unknown").toHaveLength(1);
  });

  it("alerts a device with empty cells from the global settings, and follows a change to them", async () => {
    const fake = fakePing();
    const { instance, logs, call, documents } = backend([row("a", "Router", "10.0.0.1"), row("b", "Quiet", "10.0.0.2", { over: "off" })], { start: fake.start, settings: { alertOverMs: 50 } });
    await instance.start!();
    fake.current().say(answer("10.0.0.1", 99, 5));
    fake.current().say(answer("10.0.0.2", 99, 5));
    fake.current().say(answer("10.0.0.1", 100, 70));
    fake.current().say(answer("10.0.0.2", 100, 70));
    expect(logs.map((item) => item.message)).toEqual(["Router (10.0.0.1) answered in 70 ms, over its 50 ms limit"]);
    // Raising the global limit takes effect on the next ping, with no restart.
    const settings = documents.saved().settings;
    await call("save", { operation: { kind: "settings", settings: { ...settings, alertOverMs: 100 }, expected: settings } });
    for (const second of [101, 102, 103]) fake.current().say(answer("10.0.0.1", second, 70));
    expect(logs.at(-1)!.message).toBe("Router (10.0.0.1) is back under its limit after 3 s");
  });

  it("raises a macOS notification for a drop and a recovery, and none with Notifications off", async () => {
    const fake = fakePing();
    const { instance, alerts, logs, call, documents } = backend([row("a", "RIO Truck B", "10.0.0.5", { lost: "2", over: "80" })], { start: fake.start });
    await instance.start!();
    fake.current().say(answer("10.0.0.5", 100, 4));
    fake.current().say(timeout("10.0.0.5", 101));
    fake.current().say(timeout("10.0.0.5", 102));
    expect(alerts).toEqual([
      {
        channel: "host.alert.v1",
        value: { key: "a:device-offline", title: "RIO Truck B stopped answering", body: "10.0.0.5 · no answer for 2 s", severity: "critical", notification: true, dockBounce: false },
      },
    ]);
    fake.current().say(answer("10.0.0.5", 110, 4));
    expect(alerts.at(-1)!.value).toMatchObject({ key: "a:device-online", title: "RIO Truck B is answering again after 8 s", severity: "info" });
    fake.current().say(answer("10.0.0.5", 111, 142));
    expect(alerts.at(-1)!.value).toMatchObject({ key: "a:device-slow", title: "RIO Truck B answered in 142 ms, over its 80 ms limit", body: "10.0.0.5", severity: "critical" });
    // Off: the Status Log still gets the line, and no notification is asked for.
    const settings = documents.saved().settings;
    await call("save", { operation: { kind: "settings", settings: { ...settings, notify: false }, expected: settings } });
    const before = alerts.length;
    fake.current().say(timeout("10.0.0.5", 112));
    fake.current().say(timeout("10.0.0.5", 113));
    expect(logs.at(-1)!.message).toBe("RIO Truck B (10.0.0.5) stopped answering: no answer for 2 s");
    expect(alerts).toHaveLength(before);
  });

  it("says nothing on a restart about devices that were already down, and still lights their keys and counts them", async () => {
    const fake = fakePing();
    const { instance, logs, alerts, feedback, states } = backend([row("a", "Down already", "10.0.0.5", { lost: "2" }), row("b", "Up", "10.0.0.6")], { start: fake.start });
    await instance.start!();
    instance.subscribeFeedback!([{ id: "device", fields: { actionId: "row", actionColumnId: "column", values: { "module.device": "Down already" } } }] as never, { signal: new AbortController().signal });
    fake.current().say(answer("10.0.0.6", 100, 3));
    for (const second of [100, 101, 102, 103]) fake.current().say(timeout("10.0.0.5", second));
    expect(logs, "no Status Log line").toEqual([]);
    expect(alerts, "no notification").toEqual([]);
    // It is still shown as down everywhere.
    expect(feedback.at(-1)).toMatchObject({ state: "inactive", appearance: { triggers: ["offline"] } });
    expect(states.at(-1)!.values).toMatchObject({ online: 1, alerts: 1, checked: 2 });
    // The device that was up dropping afterwards is a change, and alerts.
    for (const second of [104, 105, 106, 107]) fake.current().say(timeout("10.0.0.6", second));
    expect(logs.map((item) => item.message)).toEqual(["Up (10.0.0.6) stopped answering: no answer for 4 s"]);
    expect(alerts).toHaveLength(1);
  });

  it("clears the ping history on request, keeping each device's state and raising no alert", async () => {
    const fake = fakePing();
    const { instance, call, live, logs, alerts, documents } = backend([row("a", "Router", "10.0.0.1"), row("b", "Down", "10.0.0.2", { lost: "2" })], { start: fake.start, now: () => 110_000 });
    await instance.start!();
    for (const second of [100, 101, 102, 103]) {
      fake.current().say(answer("10.0.0.1", second, 7));
      fake.current().say(timeout("10.0.0.2", second));
    }
    const before = await live({ span: "1m", timeline: { deviceId: "a", from: 50_000, to: 110_000, points: 60 } });
    expect(before.devices.a).toMatchObject({ state: "online", average: 7, lostPct: 0 });
    expect(before.devices.b).toMatchObject({ state: "offline", lostPct: 100 });
    expect(before.timeline!.sent.reduce((sum, count) => sum + count, 0)).toBe(4);
    const saved = structuredClone(documents.saved());
    const said = logs.length + alerts.length;

    expect(await call("clear-history")).toMatchObject({ cleared: 2 });
    const after = await live({ span: "1m", timeline: { deviceId: "a", from: 50_000, to: 110_000, points: 60 } });
    // Nothing is left to average, but each device is still what it was.
    expect(after.devices.a).toMatchObject({ state: "online", now: null, average: null, lostPct: null });
    expect(after.devices.b).toMatchObject({ state: "offline", lostPct: null });
    expect(after.timeline!.sent.reduce((sum, count) => sum + count, 0)).toBe(0);
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(documents.saved(), "the saved list is untouched").toEqual(saved);
    // The next results build up again, and a device that is still down is not announced a second time.
    fake.current().say(answer("10.0.0.1", 104, 9));
    fake.current().say(timeout("10.0.0.2", 104));
    const next = await live({ span: "1m" });
    expect(next.devices.a).toMatchObject({ state: "online", now: 9, average: 9 });
    expect(next.devices.b).toMatchObject({ state: "offline", lostPct: 100 });
    expect(logs.length + alerts.length).toBe(said);
  });

  it("answers a waiting page as soon as a result arrives, with the timeline it asked for", async () => {
    const fake = fakePing();
    const { instance, live } = backend([row("a", "Router", "10.0.0.1")], { start: fake.start, now: () => 200_000, liveWaitMs: 5000 });
    await instance.start!();
    const first = await live();
    const waiting = live({ after: first.sequence, span: "1m", timeline: { deviceId: "a", from: 140_000, to: 200_000, points: 60 } });
    await delay(30);
    fake.current().say(answer("10.0.0.1", 199, 7));
    const reply = await waiting;
    expect(reply.sequence).toBeGreaterThan(first.sequence);
    expect(reply.devices.a).toMatchObject({ state: "online", now: 7, average: 7, lostPct: 0 });
    expect(reply.timeline).toMatchObject({ deviceId: "a", stepMs: 1000 });
    expect(reply.timeline!.max[58]).toBe(7);
    expect(reply.timeline!.sent).toHaveLength(60);
  });

  it("offers the page's devices to a key, and a press does nothing", async () => {
    const fake = fakePing();
    const { instance } = backend([row("a", "Router", "10.0.0.1"), row("b", "RCP 1", "10.0.0.2")], { start: fake.start });
    await instance.start!();
    expect(instance.choices!("devices")).toEqual([{ id: "Router", label: "Router" }, { id: "RCP 1", label: "RCP 1" }]);
    expect(await instance.execute("matrix", {}, {} as never)).toMatchObject({ status: "success" });
    expect(fake.runs, "a press starts nothing").toHaveLength(1);
  });
});

// The real fping, against this computer and an address that never answers (192.0.2.0/24 is reserved for examples).
describe.runIf(Boolean(findFping()))("real pings", () => {
  it("measures this computer, and shows an address that never answers as Offline without announcing it", async () => {
    const { instance, live, logs } = backend([row("a", "This computer", "127.0.0.1", { over: "500" }), row("b", "Nobody", "192.0.2.1", { lost: "2" })], { settings: { intervalMs: 200 }, liveWaitMs: 1000 });
    await instance.start!();
    let reply = await live();
    for (let i = 0; i < 40 && reply.devices.b?.state !== "offline"; i++) reply = await live({ after: reply.sequence, span: "1m" });
    expect(reply.problem).toBe("");
    expect(reply.devices.a?.state).toBe("online");
    expect(reply.devices.a!.now!).toBeLessThan(50);
    expect(reply.devices.a!.lostPct).toBe(0);
    expect(reply.devices.b).toMatchObject({ state: "offline", now: null, lostPct: 100 });
    // It never answered, so Offline is where it started: shown, but not announced.
    expect(logs).toEqual([]);
  }, 20_000);
});
