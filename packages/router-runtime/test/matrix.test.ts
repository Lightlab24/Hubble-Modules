import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseModuleMatrixValue,
  resolveModuleMatrixField,
  moduleMatrixMatches,
} from "@hubble/module-sdk";
import {
  routerMatrix,
  routerMatrixAction,
  routerLevels,
  createRouterMatrixFeedback,
  type RouterType,
} from "../src/matrix.js";
const types: RouterType[] = [
  "ross-ultrix-ogp",
  "evertz-quartz",
  "blackmagic-videohub",
  "aja-kumo",
];
it.each(types)(
  "%s declares the complete shared Matrix and translates grouped actions using stable context identity",
  (type) => {
    const matrix = routerMatrix(type),
      contextId = randomUUID(),
      groupId = randomUUID();
    expect(matrix.context).toBe(true);
    expect(
      moduleMatrixMatches(matrix.availableWhenDisabled, {
        actionType: "toggle-group-enabled",
      }),
    ).toBe(true);
    for (const actionType of [
      "route",
      "select-source",
      "select-destination",
      "take",
      "refresh-names",
    ])
      expect(
        moduleMatrixMatches(matrix.availableWhenDisabled, { actionType }),
      ).toBe(false);
    expect(
      matrix.fields.find((field) => field.id === "actionType")?.choiceFields,
    ).toEqual(["actionGroup"]);
    const action = routerMatrixAction(
      type,
      {
        contextId,
        values: {
          actionType: "select-destination",
          actionGroup: groupId,
          actionValue: "9, 3",
          drivesTally: true,
          feedbackColor:
            "#37A65B;cycle=#123456|#654321|#111111|#222222|#333333",
        },
      },
      { levels: 4 },
    );
    expect(action.fields).toMatchObject({
      moduleConnectionId: contextId,
      groupId,
      destination: 9,
      destinations: [9, 3],
      feedbackColor: "#123456",
      feedbackColors: ["#123456", "#654321"],
    });
    const field = matrix.fields.find((field) => field.id === "actionValue")!;
    expect(
      parseModuleMatrixValue(
        resolveModuleMatrixField(field, { actionType: "select-destination" }),
        "9,3",
      ),
    ).toBe("9, 3");
    expect(() =>
      parseModuleMatrixValue(
        resolveModuleMatrixField(field, { actionType: "select-destination" }),
        "9,9",
      ),
    ).toThrow("once");
  },
);
it("preserves toggle colour ordering, level ranges, protocol-specific commands and limits", () => {
  const fields = {
    contextId: randomUUID(),
    values: {
      actionType: "toggle-group",
      actionGroup: randomUUID(),
      drivesTally: true,
      feedbackColor: "#123456 | #654321",
    },
  };
  expect(
    routerMatrixAction("evertz-quartz", fields, { levels: 4 }),
  ).toMatchObject({
    id: "ross-swp08.toggle-group-enabled",
    fields: { feedbackColor: "#654321", feedbackInactiveColor: "#123456" },
  });
  expect(routerLevels("3,1-2,2", 4)).toEqual([1, 2, 3]);
  expect(() => routerLevels("1-5", 4)).toThrow("1..4");
  expect(
    routerMatrixAction(
      "evertz-quartz",
      {
        contextId: fields.contextId,
        values: { actionType: "recall-salvo", actionValue: 32 },
      },
      {},
    ),
  ).toMatchObject({ id: "evertz-quartz.recall-salvo", fields: { salvo: 32 } });
  expect(() =>
    routerMatrixAction(
      "aja-kumo",
      {
        contextId: fields.contextId,
        values: {
          actionType: "select-source",
          actionValue: 65,
          drivesTally: false,
        },
      },
      {},
    ),
  ).toThrow();
  expect(() =>
    routerMatrixAction(
      "blackmagic-videohub",
      {
        contextId: fields.contextId,
        values: { actionType: "recall-salvo", actionValue: 1 },
      },
      {},
    ),
  ).toThrow("router action");
});

it.each(types)(
  "%s preserves the established offline action labels and colors",
  (type) => {
    const choices = routerMatrix(type).fields.find(
      (field) => field.id === "actionType",
    )?.choices;
    expect(choices).toEqual(
      expect.arrayContaining([
        { value: "select-source", label: "Select SRC", textColor: "#159DDD" },
        {
          value: "select-destination",
          label: "Select DST",
          textColor: "#8B5CE5",
        },
        {
          value: "toggle-group-enabled",
          label: "Group On/Off",
          textColor: "#37A65B",
        },
      ]),
    );
  },
);
it("keeps source/address labels with no router snapshot and an unresolved legacy group", () => {
  const contextId = randomUUID();
  const action = {
    type: "ross-swp08.select-source",
    moduleConnectionId: contextId,
    connectionId: randomUUID(),
    source: 12,
    groupId: null,
    enabled: true,
    drivesTally: true,
  } as Parameters<ReturnType<typeof createRouterMatrixFeedback>>[0];
  const controller = {
    runtime: { snapshots: vi.fn(() => []) },
    snapshot: vi.fn(() => ({
      contexts: [
        {
          reference: { contextId },
          settings: {
            groups: [{ id: randomUUID(), name: "New group" }],
            groupAliases: {},
          },
        },
      ],
    })),
  };
  const groups = controller as unknown as Parameters<
    typeof createRouterMatrixFeedback
  >[1];
  const render = createRouterMatrixFeedback(randomUUID(), groups, []);
  const feedback = render(action);
  expect(feedback.state).toBe("unavailable");
  expect(feedback.appearance?.backgroundColor).toBeNull();
  expect(feedback.appearance?.cells).toMatchObject({
    actionType: { label: "Select SRC" },
    actionValue: { label: "12 — Unlabeled" },
  });
  expect(render(action)).toEqual(feedback);
  expect(controller.snapshot).toHaveBeenCalledOnce();
  expect(controller.runtime.snapshots).toHaveBeenCalledOnce();
});

it.each(types)(
  "%s declares offline SRC and DST value colors, including legacy aliases",
  (type) => {
    const field = routerMatrix(type).fields.find(
      (item) => item.id === "actionValue",
    )!;
    for (const actionType of ["select-source", "select-src"])
      expect(resolveModuleMatrixField(field, { actionType }).textColor).toBe(
        "#159DDD",
      );
    for (const actionType of ["select-destination", "select-dst"])
      expect(resolveModuleMatrixField(field, { actionType }).textColor).toBe(
        "#8B5CE5",
      );
    for (const actionType of ["", "take", "lock-destination", "recall-salvo"])
      expect(
        resolveModuleMatrixField(field, { actionType }).textColor,
      ).toBeUndefined();
    expect(field.showIncompleteWarning).toBe(false);
    expect(() =>
      parseModuleMatrixValue(
        resolveModuleMatrixField(field, { actionType: "select-source" }),
        "",
      ),
    ).toThrow();
  },
);
