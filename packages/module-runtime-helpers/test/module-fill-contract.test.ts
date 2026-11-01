import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveModuleMatrixField } from "@hubble/module-sdk";
import type { ModuleManifestSource } from "@hubble/module-sdk/authoring";

const root = new URL("../../../modules/", import.meta.url);
const names = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = new Map<string, ModuleManifestSource>();
for (const name of names)
  manifests.set(
    name,
    (await import(new URL(`${name}/src/manifest.ts`, root).href))
      .default as ModuleManifestSource,
  );

const series: Record<string, readonly string[]> = {
  "aja-kumo": ["source", "destination"],
  "blackmagic-videohub": ["source", "destination"],
  ccc: ["cameraId"],
  "cyanview-rcp": ["cameraNumber"],
  "cyanview-studio": ["feedNumber", "feedId"],
  "dit-browse": [],
  "evertz-quartz": ["source", "destination"],
  "http-requests": [],
  lightencode: [],
  livegrade: ["sequence", "slotId"],
  "ross-ultrix-ogp": ["source", "destination"],
  "system-actions": [],
  tsl: ["tallyAddress"],
};

describe("module-owned fill declarations", () => {
  it("accounts for every production project, including page-only and observation-only modules", () => {
    expect(names).toEqual(
      [...Object.keys(series), "mqtt-capture", "tally-switch"].sort(),
    );
    expect(manifests.get("mqtt-capture")?.matrix).toBeUndefined();
    expect(manifests.get("tally-switch")?.matrix).toBeUndefined();
  });

  it.each(Object.keys(series))(
    "%s retains its declared numeric series and copies other field values",
    (name) => {
      const matrix = manifests.get(name)?.matrix;
      expect(matrix, name).toBeDefined();
      expect(
        matrix?.fields
          .filter((field) => field.fill === "series")
          .map((field) => field.id)
          .sort(),
      ).toEqual([...series[name]!].sort());
      for (const field of matrix!.fields)
        expect(field.fill, `${name}.${field.id}`).toBe(
          series[name]!.includes(field.id) ? "series" : "copy",
        );
    },
  );

  it("increments DIT camera/workspace numbers while copying its lock choice", () => {
    const field = manifests
      .get("dit-browse")!
      .matrix!.fields.find((field) => field.id === "actionValue")!;
    expect(
      resolveModuleMatrixField(field, { actionType: "focus-camera" }).fill,
    ).toBe("series");
    expect(
      resolveModuleMatrixField(field, { actionType: "switch-workspace" }).fill,
    ).toBe("series");
    expect(
      resolveModuleMatrixField(field, { actionType: "set-grid-lock" }).fill,
    ).toBe("copy");
  });

  it("increments Light Encode slots while copying timer duration", () => {
    const field = manifests
      .get("lightencode")!
      .matrix!.fields.find((field) => field.id === "actionValue")!;
    expect(
      resolveModuleMatrixField(field, { actionType: "record-toggle-slot" })
        .fill,
    ).toBe("series");
    expect(
      resolveModuleMatrixField(field, { actionType: "timer-set-minutes" }).fill,
    ).toBe("copy");
  });

  it.each([
    "aja-kumo",
    "blackmagic-videohub",
    "evertz-quartz",
    "ross-ultrix-ogp",
  ])(
    "%s increments scalar addresses and preserves a destination cycle as one value",
    (name) => {
      const field = manifests
        .get(name)!
        .matrix!.fields.find((field) => field.id === "actionValue")!;
      expect(
        resolveModuleMatrixField(field, { actionType: "select-source" }).fill,
      ).toBe("series");
      expect(
        resolveModuleMatrixField(field, { actionType: "select-destination" })
          .fill,
      ).toBe("copy");
      expect(manifests.get(name)!.host).toMatchObject({
        requiredFeatures: expect.arrayContaining([
          "module-matrix-fill-rules-v1",
        ]),
      });
    },
  );

  it.each(names)(
    "%s declares every editable page column and leaves observed/computed cells read-only",
    (name) => {
      for (const page of manifests.get(name)!.pages ?? [])
        for (const section of page.sections) {
          if (section.type !== "table" || section.source === "state") continue;
          for (const column of section.columns) {
            if (section.computed?.columns.includes(column.id)) continue;
            expect(
              section.workbook?.columns?.[column.id]?.fill,
              `${name}.${section.id}.${column.id}`,
            ).toMatch(/^(copy|series)$/);
          }
        }
    },
  );
});
