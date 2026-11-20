import { expect, it } from "vitest";
import { ModuleMatrixSchema } from "../src/matrix.js";

const base = {
  id: "camera",
  label: "Camera",
  actionId: "record",
  feedbackId: "camera",
  primaryField: "module.camera",
  fields: [
    { id: "module.camera", label: "Camera", type: "number", default: 1 },
  ],
};

it("declares which rows also answer a hold, and only with a supported length", () => {
  expect(ModuleMatrixSchema.parse(base).hold).toBeUndefined();
  expect(
    ModuleMatrixSchema.parse({
      ...base,
      hold: { ms: 2000, when: [{ field: "module.camera", values: [1] }] },
    }).hold,
  ).toEqual({ ms: 2000, when: [{ field: "module.camera", values: [1] }] });
  expect(
    ModuleMatrixSchema.safeParse({ ...base, hold: { ms: 1500 } }).success,
  ).toBe(false);
});

it("lets the disc that fills while a key is held take the module's colour", () => {
  expect(
    ModuleMatrixSchema.parse({ ...base, hold: { ms: 2000, color: "#e3242b" } })
      .hold,
  ).toEqual({ ms: 2000, color: "#e3242b" });
  expect(
    ModuleMatrixSchema.safeParse({
      ...base,
      hold: { ms: 2000, color: "red" },
    }).success,
  ).toBe(false);
});
