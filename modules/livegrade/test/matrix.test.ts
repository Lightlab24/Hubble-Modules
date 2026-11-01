import { expect, it } from "vitest";
import { resolveModuleMatrix } from "@hubble/module-sdk";
import { liveGradeMatrixAction, matrix } from "../src/matrix.js";

it("retains generation and command-specific defaults, formulas, nullable position and series fill", () => {
  for (const [generation, command, expected] of [
    [6, "select-slot", "6"],
    [7, "select-slot", "7"],
    [6, "select-slot-pro6", "pro6"],
    [6, "select-slot-frontier", "frontier"],
  ] as const) {
    const resolved = resolveModuleMatrix(matrix, {
      generation,
      "column.commandId": command,
    });
    expect(resolved.fields.find((f) => f.id === "module.application")?.default).toBe(
      expected,
    );
    expect(resolved.fields.find((f) => f.id === "sequence")).toMatchObject({
      default: null,
      formula: true,
      fill: "series",
    });
  }
});
it("owns the Studio letter/position rules and preserves 7/Frontier typed queries", () => {
  const action = (values: Record<string, string | number | null>) =>
    liveGradeMatrixAction({ values }, { generation: 6 });
  expect(
    action({ slotId: "c", sequence: null, assignmentMode: "manual" }).fields,
  ).toMatchObject({ application: "6", slotId: "C", sequence: 3 });
  expect(action({ slotId: "3", sequence: null }).fields).toMatchObject({
    slotId: "C",
    sequence: 3,
  });
  expect(action({ slotId: "", sequence: 3 }).fields).toMatchObject({
    slotId: "C",
    sequence: 3,
  });
  const invalid: Record<string, string | number | null>[] = [
    { slotId: "C", sequence: 2 },
    { slotId: "3", assignmentMode: "manual" },
    { slotId: "", sequence: 27 },
  ]
  for (const values of invalid) expect(() => action(values)).toThrow();
  expect(
    action({ application: "frontier", slotId: "Camera Blue", sequence: null })
      .fields,
  ).toMatchObject({ slotId: "Camera Blue", sequence: null });
});
