import { expect, it } from "vitest";
import {
  moduleMatrixMatches,
  resolveModuleMatrixField,
} from "@hubble/module-sdk";
import { routerMatrix } from "../src/matrix.js";
import { matrix as ccc } from "../../../modules/ccc/src/matrix.js";
import { matrix as rcp } from "../../../modules/cyanview-rcp/src/matrix.js";
import { matrix as dit } from "../../../modules/dit-browse/src/matrix.js";
import { matrix as encode } from "../../../modules/lightencode/src/matrix.js";
import { matrix as tsl } from "../../../modules/tsl/src/matrix.js";

const cases = [
  ...(
    [
      "ross-ultrix-ogp",
      "evertz-quartz",
      "blackmagic-videohub",
      "aja-kumo",
    ] as const
  ).flatMap((type) =>
    [
      "select-source",
      "select-destination",
      "toggle-group-enabled",
      "route",
      "take",
    ].map((actionType) => ({
      name: `${type} ${actionType}`,
      matrix: routerMatrix(type),
      actionType,
    })),
  ),
  { name: "CCC", matrix: ccc, actionType: "toggle-camera-enabled" },
  { name: "RCP", matrix: rcp, actionType: "select-camera" },
  ...["focus-camera", "toggle-grid-lock"].map((actionType) => ({
    name: `DIT ${actionType}`,
    matrix: dit,
    actionType,
  })),
  { name: "Light Encode", matrix: encode, actionType: "record-toggle-all" },
];

it.each(cases)(
  "$name keeps feedback colors editable with feedback and the action off",
  ({ matrix, actionType }) => {
    const values = {
      actionType,
      enabled: false,
      feedback: false,
      drivesTally: false,
      actionValue: "1,2",
      feedbackColor: "#123456 | #654321",
    };
    const field = resolveModuleMatrixField(
      matrix.fields.find((item) => item.id === "feedbackColor")!,
      values,
    );
    expect(field.type).toBe("color");
    expect(moduleMatrixMatches(field.enabledWhen, values)).toBe(true);
  },
);

it("TSL keeps color and glow preferences editable when its feedback checkbox is off", () => {
  const choice = tsl.fields
    .find((field) => field.id === "actionType")!
    .choiceEditor!.choices.find((item) => item.value === "tally-feedback")!;
  for (const id of ["colors", "glow"]) {
    const parameter = choice.parameters.find((field) => field.id === id)!;
    expect(
      moduleMatrixMatches(parameter.enabledWhen, { feedback: false }),
    ).toBe(true);
  }
});

it("still hides feedback colors for actions that do not use feedback", () => {
  for (const [matrix, actionType] of [
    [ccc, "set-camera-label"],
    [rcp, "record-camera"],
    [dit, "show-grid"],
    [routerMatrix("aja-kumo"), "refresh-names"],
  ] as const) {
    const field = matrix.fields.find((item) => item.id === "feedbackColor")!;
    expect(
      moduleMatrixMatches(field.enabledWhen, {
        actionType,
        feedback: true,
        drivesTally: true,
      }),
    ).toBe(false);
  }
});
