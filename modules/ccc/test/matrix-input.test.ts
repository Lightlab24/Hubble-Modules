import { expect, it } from "vitest";
import { matrix, matrixAction, matrixFeedback } from "../src/matrix.js";
import { resolveCccCameraRow } from "../src/config.js";

const rows = [1, 2, 16].map((cameraNumber) => ({
  rowId: `00000000-0000-4000-8000-${String(cameraNumber).padStart(12, "0")}`,
  cameraNumber,
  rcpIp: "192.0.2.1",
  enabled: true,
}));
const observe = (source: string, drivesTally = true) =>
  matrixFeedback({
    data: new Map([["host.ccc", { config: { rows } }]]),
    feedback: new Map(),
    events: new Map(),
    state: undefined,
    settings: {},
    fields: {
      values: {
        actionType: "toggle-camera-enabled",
        cameraId: source,
        enabled: true,
        drivesTally,
        feedbackColor: "#37A65B",
      },
    },
  });
it("keeps numeric input in the action and resolves each filled row independently", () => {
  expect(matrix.fields.find((field) => field.id === "cameraId")).toMatchObject({
    fill: "series",
    formula: true,
  });
  for (const number of [1, 2, 16]) {
    const input = String(number);
    const action = matrixAction({
      values: { actionType: "toggle-camera-enabled", cameraId: input },
    });
    expect(action.fields.cameraId).toBe(input);
    expect(resolveCccCameraRow(rows, input)?.cameraNumber).toBe(number);
    expect(observe(input).appearance?.cells?.cameraId).toEqual({
      color: null,
      label: `192.0.2.1 · Camera ${number}`,
    });
  }
});
it("supplies editable numbers for legacy UUIDs even with button colouring off", () => {
  for (const row of rows) {
    expect(observe(row.rowId, false).appearance?.cells?.cameraId).toEqual({
      color: null,
      label: `192.0.2.1 · Camera ${row.cameraNumber}`,
      inputSource: String(row.cameraNumber),
    });
    expect(resolveCccCameraRow(rows, row.rowId)).toBe(row);
  }
});
it("rejects an ambiguous number without selecting a different RCP", () => {
  const duplicate = {
    ...rows[0]!,
    rowId: "00000000-0000-4000-8000-000000000099",
    rcpIp: "192.0.2.2",
  };
  expect(() => resolveCccCameraRow([...rows, duplicate], "1")).toThrow(
    "more than one RCP",
  );
  expect(resolveCccCameraRow([...rows, duplicate], duplicate.rowId)).toBe(
    duplicate,
  );
});
