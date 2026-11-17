import { describe, expect, it } from "vitest";
import { DraftStore, type SaveReceipt } from "../src/draft-store.js";
import {
  applyMutation,
  defaultDocument,
  idleStatus,
  insertRows,
  inverse,
  moveRows,
  newMonitor,
  removeRows,
  validateDocument,
  validateValue,
  type MonitorDocument,
  type Mutation,
} from "../src/model.js";

const row = (id: string, name: string, values: Record<string, string> = {}) => ({
  id,
  values: { name, enabled: "TRUE", host: "10.0.0.5", port: "18181", whenInUse: "wait", ...values },
});
const plan = (...monitors: MonitorDocument["monitors"]): MonitorDocument => ({ ...defaultDocument(), monitors });
const edit = (rowId: string, columnId: string, value: string, expected: string): Mutation => ({ kind: "edit", edits: [{ rowId, columnId, value, expected }] });

/** A workspace whose saves wait until the test lets each one through, or fails it. */
function heldWorkspace(initial: MonitorDocument) {
  let saved = structuredClone(initial);
  let revision = 1;
  const waiting: { operation: Mutation; resolve: () => void; reject: (error: Error) => void }[] = [];
  const store = new DraftStore({ document: initial, revision: "rev-1" }, (operation) =>
    new Promise<SaveReceipt>((resolve, reject) => {
      waiting.push({
        operation,
        resolve: () => {
          saved = applyMutation(saved, operation);
          resolve({ document: structuredClone(saved), revision: `rev-${++revision}` });
        },
        reject,
      });
    }),
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { store, waiting, saved: () => saved, settle };
}

describe("the monitor list", () => {
  it("checks every cell's value", () => {
    expect(validateValue("name", " ")).toMatch(/name/);
    expect(validateValue("host", "")).toBeUndefined();
    expect(validateValue("host", "192.168.155.240")).toBeUndefined();
    expect(validateValue("host", "grade-1.local")).toBeUndefined();
    expect(validateValue("host", "10.0.0.999")).toMatch(/IPv4/);
    expect(validateValue("port", "18181")).toBeUndefined();
    expect(validateValue("port", "70000")).toMatch(/port/);
    expect(validateValue("enabled", "yes")).toMatch(/Enabled/);
    expect(validateValue("whenInUse", "send")).toBeUndefined();
    expect(validateValue("whenInUse", "always")).toMatch(/Choose/);
    expect(validateValue("status", "Sent")).toMatch(/can't be edited/);
  });

  it("refuses two monitors with one name, since buttons pick monitors by name", () => {
    expect(() => validateDocument(plan(row("a", "Grade 1"), row("b", "grade 1 ")))).toThrow(/already called/);
  });

  it("applies an edit only over the value it was made on, and undoes it", () => {
    const before = plan(row("a", "Grade 1"));
    const change = edit("a", "host", "10.0.0.6", "10.0.0.5");
    const after = applyMutation(before, change);
    expect(after.monitors[0]!.values.host).toBe("10.0.0.6");
    expect(() => applyMutation(after, change)).toThrow(/changed before/);
    expect(applyMutation(after, inverse(before, change))).toEqual(before);
  });

  it("adds, moves and removes monitors as single undoable steps", () => {
    const start = plan(row("a", "Grade 1"), row("b", "Grade 2"));
    const added = newMonitor(start, "c");
    expect(added.values).toEqual({ name: "Monitor 3", enabled: "TRUE", host: "", port: "18181", whenInUse: "wait" });
    const insert = insertRows(start, [added], "b");
    const withNew = applyMutation(start, insert);
    expect(withNew.monitors.map((item) => item.id)).toEqual(["a", "c", "b"]);
    const move = moveRows(withNew, ["a"], null)!;
    const moved = applyMutation(withNew, move);
    expect(moved.monitors.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(moveRows(moved, ["a"], null)).toBeNull();
    const removed = applyMutation(moved, removeRows(moved, ["b"]));
    expect(removed.monitors.map((item) => item.id)).toEqual(["c", "a"]);
    expect(applyMutation(removed, inverse(moved, removeRows(moved, ["b"])))).toEqual(moved);
    expect(applyMutation(withNew, inverse(start, insert))).toEqual(start);
  });

  it("names a new monitor after the first free number and shows Ready, Off or Needs an IP address", () => {
    expect(newMonitor(plan(row("a", "Monitor 2")), "b").values.name).toBe("Monitor 3");
    expect(idleStatus(row("a", "A"))).toBe("Ready");
    expect(idleStatus(row("a", "A", { host: "" }))).toBe("Needs an IP address");
    expect(idleStatus(row("a", "A", { enabled: "FALSE" }))).toBe("Off");
  });
});

describe("page edits", () => {
  it("show at once, take a second edit while the first save is held, and save both in order", async () => {
    const workspace = heldWorkspace(plan(row("a", "Grade 1")));
    expect(workspace.store.submit(edit("a", "host", "10.0.0.6", "10.0.0.5"))).toBe(true);
    expect(workspace.store.document.monitors[0]!.values.host).toBe("10.0.0.6");
    expect(workspace.store.submit(edit("a", "name", "Grade A", "Grade 1"))).toBe(true);
    expect(workspace.store.document.monitors[0]!.values).toMatchObject({ host: "10.0.0.6", name: "Grade A" });
    expect(workspace.waiting).toHaveLength(1);
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    expect(workspace.waiting).toHaveLength(1);
    expect(workspace.store.document.monitors[0]!.values).toMatchObject({ host: "10.0.0.6", name: "Grade A" });
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    expect(workspace.store.pending).toHaveLength(0);
    expect(workspace.saved().monitors[0]!.values).toMatchObject({ host: "10.0.0.6", name: "Grade A" });
  });

  it("roll back a failed save, keep a later unrelated edit, and leave the failed value to correct", async () => {
    const workspace = heldWorkspace(plan(row("a", "Grade 1"), row("b", "Grade 2")));
    workspace.store.submit(edit("a", "host", "10.0.0.6", "10.0.0.5"));
    workspace.store.submit(edit("b", "port", "18182", "18181"));
    workspace.waiting.shift()!.reject(new Error("Workspace changed"));
    await workspace.settle();
    expect(workspace.store.document.monitors[0]!.values.host).toBe("10.0.0.5");
    expect(workspace.store.document.monitors[1]!.values.port).toBe("18182");
    expect(workspace.store.invalid.get("a/host")).toMatchObject({ message: "Workspace changed", edit: { value: "10.0.0.6" } });
    expect(workspace.store.error).toBe("Workspace changed");
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    expect(workspace.saved().monitors.map((item) => item.values.port)).toEqual(["18181", "18182"]);
    expect(workspace.store.undo).toHaveLength(1);
  });

  it("keep an invalid value visible without saving it, and undo and redo saved edits", async () => {
    const workspace = heldWorkspace(plan(row("a", "Grade 1")));
    expect(workspace.store.submit(edit("a", "host", "10.0.0.999", "10.0.0.5"))).toBe(false);
    expect(workspace.store.invalid.get("a/host")?.message).toMatch(/IPv4/);
    expect(workspace.waiting).toHaveLength(0);
    workspace.store.discard("a", "host");
    expect(workspace.store.invalid.size).toBe(0);
    workspace.store.submit(edit("a", "name", "Grade A", "Grade 1"));
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    workspace.store.history(false);
    expect(workspace.store.document.monitors[0]!.values.name).toBe("Grade 1");
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    workspace.store.history(true);
    expect(workspace.store.document.monitors[0]!.values.name).toBe("Grade A");
    workspace.waiting.shift()!.resolve();
    await workspace.settle();
    expect(workspace.saved().monitors[0]!.values.name).toBe("Grade A");
  });
});
