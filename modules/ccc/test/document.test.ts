import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { normalizeCccIp } from "../src/config.js";
import {
  cccDocumentConfig,
  migrateCccDocument,
  prepareCccDocument,
} from "../src/document.js";
import type { ModuleValues } from "@hubble/module-sdk";

function fixture() {
  const rows = [1, 2].map((cameraNumber) => ({
    rowId: randomUUID(),
    enabled: cameraNumber === 1,
    rcpIp: "192.0.2.2",
    cameraNumber,
  }));
  const legacy = { revision: 19, rows, singleSwitch: true };
  const value = migrateCccDocument({
    id: "cameras",
    fromVersion: 0,
    toVersion: 1,
    value: legacy,
  }) as ModuleValues;
  const prepare = (next: unknown, intent = "write") =>
    prepareCccDocument({
      id: "cameras",
      version: 1,
      intent,
      before: { version: 1, value },
      value: next,
    });
  return { rows, legacy, value, prepare };
}
it("imports legacy IDs, ordering, selection and revision with no mutation or device activity", () => {
  const f = fixture();
  expect(cccDocumentConfig(f.value)).toEqual(f.legacy);
  expect(f.legacy.revision).toBe(19);
  expect(() =>
    migrateCccDocument({
      id: "other",
      fromVersion: 0,
      toVersion: 1,
      value: f.legacy,
    }),
  ).toThrow("Unsupported");
});
it("normalizes single switch in the package and preserves unrelated document/layout values", () => {
  const f = fixture();
  const next = structuredClone(f.value) as any;
  next.cameras[1].values.enabled = true;
  next.camerasView = {
    version: 1,
    columnOrder: ["cameraNumber", "enabled", "rcpIp"],
    sheets: [{ id: "stage", name: "Stage B" }],
    sheetByRowId: { [f.rows[1]!.rowId]: "stage" },
    textSize: 17,
  };
  next.future = { keep: true };
  const saved = f.prepare(next) as any;
  expect(cccDocumentConfig(saved)).toMatchObject({
    revision: 20,
    singleSwitch: true,
    rows: [{ enabled: false }, { enabled: true }],
  });
  expect(saved.camerasView).toMatchObject(next.camerasView);
  expect(saved.future).toEqual({ keep: true });
  expect(f.rows[0]!.enabled).toBe(true);
});
it("does not change camera revision for layout edits and preserves exact history values", () => {
  const f = fixture();
  expect(
    cccDocumentConfig(
      f.prepare({ ...f.value, camerasView: { version: 1, textSize: 20 } }),
    ).revision,
  ).toBe(19);
  expect(f.prepare(f.value, "undo")).toEqual(f.value);
});
it.each([
  "invalid-ip",
  "duplicate-target",
  "fraction",
  "negative",
  "too-large",
])("rejects %s without changing the saved document", (problem) => {
  const f = fixture(),
    next = structuredClone(f.value) as any;
  if (problem === "invalid-ip") next.cameras[0].values.rcpIp = "not-an-ip";
  else if (problem === "duplicate-target")
    next.cameras[1].values.cameraNumber = "1";
  else
    next.cameras[0].values.cameraNumber = {
      fraction: "1.5",
      negative: "-1",
      "too-large": "1000000",
    }[problem];
  expect(() => f.prepare(next)).toThrow();
  expect(cccDocumentConfig(f.value)).toEqual(f.legacy);
});
it("keeps incomplete blank rows editable and accepts normalized IPv6 addresses", () => {
  const f = fixture(),
    next = structuredClone(f.value) as any;
  next.cameras[0].values.rcpIp = " [2001:0db8::1] ";
  next.cameras.push({
    id: randomUUID(),
    values: { enabled: false, rcpIp: "", cameraNumber: "" },
  });
  const saved = cccDocumentConfig(f.prepare(next));
  expect(saved.rows[0]!.rcpIp).toBe("2001:db8::1");
  expect(saved.rows[2]).toMatchObject({
    enabled: false,
    rcpIp: "",
    cameraNumber: null,
  });
});

it("normalizes addresses without putting IPv4 through the IPv6 parser", () => {
  const url = vi.spyOn(globalThis, "URL");
  expect(normalizeCccIp(" 192.0.2.2 ")).toBe("192.0.2.2");
  expect(normalizeCccIp("")).toBe("");
  expect(url).not.toHaveBeenCalled();
  url.mockRestore();
  expect(normalizeCccIp(" [2001:0DB8:0:0:0:0:0:1] ")).toBe("2001:db8::1");
  expect(normalizeCccIp("not:an:address")).toBe("not:an:address");
});
