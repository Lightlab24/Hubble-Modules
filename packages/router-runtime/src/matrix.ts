import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ModuleMatrixSchema,
  parseModuleOrderedNumbers,
  parseModuleColorPalette,
  type ModuleValues,
  type ModuleJsonValue,
  type ModuleChoice,
  type ModuleChoiceQuery,
  type ModuleChoicePage,
  type ModuleFeedback,
} from "@hubble/module-sdk";
import type { RouterConnectionDefinition } from "./types.js";
import type { RouterActionDefinition } from "./actions.js";
import type {
  RouterConnectionManagerContract,
  ManagedRouterConnectionSnapshot,
} from "./connection-contract.js";
import type {
  RouterGroupController,
  RouterMatrixDestinationRow,
} from "./group-controller.js";
import { resolveRouterGroup } from "./group-document.js";
import { resolveRossGroupFeedback } from "./group-feedback.js";

export type RouterType = RouterConnectionDefinition["type"];
export const ROUTER_PALETTE = [
  "#FF0000",
  "#0000FF",
  "#FFFF00",
  "#00FF00",
  "#FF7600",
];
export const routerLabels: Record<RouterType, string> = {
  "ross-ultrix-ogp": "Ross Ultrix OGP",
  "evertz-quartz": "Evertz Quartz",
  "blackmagic-videohub": "Blackmagic Videohub",
  "aja-kumo": "AJA KUMO",
};
const grouped = [
  "select-source",
  "select-destination",
  "take",
  "toggle-group-enabled",
];
const feedbackActions = [...grouped, "route"];
const labels: Record<string, string> = {
  "": "No action",
  "select-source": "Select SRC",
  "select-destination": "Select DST",
  take: "Take",
  "toggle-group-enabled": "Group On/Off",
  route: "Direct Route",
  "refresh-names": "Refresh Router Names",
  "lock-destination": "Lock Destination",
  "unlock-destination": "Unlock Destination",
  "recall-salvo": "Recall Salvo",
};
const labelColors: Record<string, string> = {
  "select-source": "#159DDD",
  "select-destination": "#8B5CE5",
  "toggle-group-enabled": "#37A65B",
};
const aliases: Record<string, string> = {
  "select-src": "select-source",
  "select-dst": "select-destination",
  "toggle-group": "toggle-group-enabled",
  "direct-route": "route",
  refresh: "refresh-names",
  "refresh-router-names": "refresh-names",
};
export function routerActionName(input: unknown): string {
  const value = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
  return aliases[value] ?? value;
}
const singleLevel = (type: RouterType) =>
  type === "blackmagic-videohub" || type === "aja-kumo";
export const routerActionNames = (type: RouterType) => [
  "",
  ...grouped,
  "route",
  "refresh-names",
  ...(type === "evertz-quartz"
    ? ["lock-destination", "unlock-destination", "recall-salvo"]
    : type === "aja-kumo"
      ? ["recall-salvo"]
      : []),
];
const when = (...values: string[]) => [
  {
    field: "actionType",
    values: [
      ...new Set(
        values.flatMap((value) => [
          value,
          ...Object.entries(aliases)
            .filter(([, canonical]) => canonical === value)
            .map(([alias]) => alias),
        ]),
      ),
    ],
  },
];
const numbers = (maximum: number) => ({
  min: 1,
  max: maximum,
  minItems: 1,
  maxItems: 5,
  itemLabel: "Destination",
});

export function routerMatrix(type: RouterType) {
  const maximum = type === "aja-kumo" ? 64 : 65536;
  return ModuleMatrixSchema.parse({
    id: "routing",
    label: routerLabels[type],
    actionId: "matrix",
    feedbackId: "matrix",
    primaryField: "actionType",
    context: true,
    legacy: { adapter: type, normalize: true, connectionType: type },
    inactiveWhen: when(""),
    availableWhenDisabled: when("toggle-group-enabled"),
    variants: routerActionNames(type)
      .filter(Boolean)
      .map((action) => ({
        when: [
          {
            field: "column.commandId",
            values: [action, action === "route" ? "direct-route" : action],
          },
        ],
        fields: { actionType: { default: action } },
      })),
    fields: [
      {
        fill: "copy",
        id: "enabled",
        label: "Enabled",
        type: "boolean",
        default: true,
        width: 88,
      },
      {
        fill: "copy",
        id: "actionType",
        label: "Action",
        type: "text",
        default: "",
        choiceProvider: "matrix-actions",
        choices: [...routerActionNames(type), ...Object.keys(aliases)].map(
          (value) => {
            const canonical = routerActionName(value);
            return {
              value,
              label: labels[canonical] ?? canonical,
              ...(labelColors[canonical]
                ? { textColor: labelColors[canonical] }
                : {}),
            };
          },
        ),
        choiceFields: ["actionGroup"],
        width: 280,
      },
      {
        fill: "copy",
        id: "actionGroup",
        label: "Routing group",
        type: "text",
        default: "",
        hidden: true,
        enabledWhen: when(...grouped),
        width: 200,
      },
      {
        fill: "copy",
        id: "actionValue",
        showIncompleteWarning: false,
        label: "SRC / DST",
        type: "text",
        default: "",
        formula: true,
        choiceProvider: "matrix-value",
        width: 240,
        enabledWhen: when(
          "select-source",
          "select-destination",
          "lock-destination",
          "unlock-destination",
          "recall-salvo",
        ),
        rules: [
          { when: when("select-source"), set: { textColor: "#159DDD" } },
          {
            when: when("select-destination"),
            set: { textColor: "#8B5CE5" },
          },
          {
            when: when(
              "select-source",
              "lock-destination",
              "unlock-destination",
            ),
            set: {
              type: "number",
              required: true,
              min: 1,
              max: maximum,
              integer: true,
              fill: "series",
            },
          },
          {
            when: when("recall-salvo"),
            set: {
              type: "number",
              required: true,
              min: 1,
              max: type === "evertz-quartz" ? 32 : 8,
              integer: true,
              fill: "series",
            },
          },
          {
            when: when("select-destination"),
            set: {
              type: "text",
              required: true,
              orderedNumbers: numbers(maximum),
              // A destination cycle is one ordered selection, not a numeric seed.
              fill: "copy",
            },
          },
        ],
      },
      ...(!singleLevel(type)
        ? [
            {
              fill: "copy",
              id: "levels",
              label: "Levels",
              type: "text",
              default: "",
              formula: true,
              width: 120,
              enabledWhen: when("select-source", "take", "route"),
            },
          ]
        : []),
      {
        fill: "series",
        id: "source",
        label: "Direct SRC",
        type: "number",
        default: null,
        formula: true,
        required: true,
        integer: true,
        min: 1,
        max: maximum,
        choiceProvider: "matrix-sources",
        width: 240,
        enabledWhen: when("route"),
      },
      {
        fill: "series",
        id: "destination",
        label: "Direct DST",
        type: "number",
        default: null,
        formula: true,
        required: true,
        integer: true,
        min: 1,
        max: maximum,
        choiceProvider: "matrix-destinations",
        width: 240,
        enabledWhen: when("route"),
      },
      {
        fill: "copy",
        id: "drivesTally",
        label: "Button Feedback",
        type: "boolean",
        default: true,
        width: 112,
        enabledWhen: when(...feedbackActions),
      },
      {
        fill: "copy",
        id: "feedbackColor",
        label: "Feedback Color",
        type: "color",
        default: "#37A65B",
        width: 160,
        colorMode: "single",
        colorPalette: {
          defaults: ROUTER_PALETTE,
          itemsField: "actionValue",
          itemLabel: "DST",
        },
        enabledWhen: when(...feedbackActions),
        rules: [
          { when: when("select-destination"), set: { colorMode: "palette" } },
          { when: when("toggle-group-enabled"), set: { colorMode: "pair" } },
        ],
      },
    ],
  });
}

export function routerLevels(input: unknown, maximum: number): number[] {
  const source = String(input ?? "").trim();
  if (!source) return [];
  const levels = new Set<number>();
  for (const part of source.split(",")) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/u.exec(part.trim());
    if (!match) throw new Error("Levels must use values such as 1,2 or 1-4");
    const first = Number(match[1]),
      last = Number(match[2] ?? match[1]);
    if (first < 1 || last < first || last > maximum)
      throw new Error(`Levels must stay within 1..${maximum}`);
    for (let level = first; level <= last; level++) levels.add(level);
  }
  return [...levels].sort((left, right) => left - right);
}
export function routerMatrixAction(
  type: RouterType,
  fields: ModuleValues,
  settings: ModuleValues,
): { id: string; fields: ModuleValues } {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const action = routerActionName(values.actionType);
  if (!action || !routerActionNames(type).includes(action))
    throw new Error("Choose a router action");
  const maximum = type === "aja-kumo" ? 64 : 65536;
  const address = (value: unknown) => {
    if (value === "" || value == null)
      throw new Error("Enter a router address");
    return z.coerce.number().int().min(1).max(maximum).parse(value);
  };
  const input: Record<string, ModuleJsonValue> = {
    moduleConnectionId: z.uuid().parse(fields.contextId),
  };
  if (grouped.includes(action))
    input.groupId = values.actionGroup
      ? z.uuid().parse(values.actionGroup)
      : null;
  if (action === "toggle-group-enabled" && input.groupId === null)
    throw new Error("Choose a routing group");
  const prefix = singleLevel(type) ? type : "ross-swp08";
  const id = `${["lock-destination", "unlock-destination", "recall-salvo"].includes(action) ? type : prefix}.${action === "route" ? "direct-route" : action}`;
  if (feedbackActions.includes(action)) {
    input.drivesTally = values.drivesTally === true;
    if (action === "toggle-group-enabled") {
      const colors = z
        .array(z.string().regex(/^#[0-9a-f]{6}$/iu))
        .min(1)
        .max(2)
        .parse(
          String(values.feedbackColor || "#37A65B")
            .split("|")
            .map((item) => item.trim()),
        );
      input.feedbackColor = colors.at(-1)!;
      input.feedbackInactiveColor = colors.length > 1 ? colors[0]! : null;
    } else {
      const palette = parseModuleColorPalette(
        String(values.feedbackColor || "#37A65B"),
        5,
      );
      if (!palette) throw new Error("Choose valid feedback colours");
      input.feedbackColor = palette.singletonColor;
      if (action === "select-destination") {
        const parsed = parseModuleOrderedNumbers(
          values.actionValue,
          numbers(maximum),
        );
        if (!parsed.success) throw new Error(parsed.message);
        input.destination = parsed.values[0]!;
        if (parsed.values.length > 1) {
          const colors = (palette.cycleColors ?? ROUTER_PALETTE).slice(
            0,
            parsed.values.length,
          );
          input.destinations = parsed.values;
          input.feedbackColors = colors;
          input.feedbackColor = colors[0]!;
        }
      }
    }
  }
  if (action === "select-source") input.source = address(values.actionValue);
  if (action === "route") {
    input.source = address(values.source);
    input.destination = address(values.destination);
  }
  if (!singleLevel(type) && ["select-source", "take", "route"].includes(action))
    input.levels = routerLevels(values.levels, Number(settings.levels ?? 1));
  if (action === "lock-destination" || action === "unlock-destination")
    input.destination = address(values.actionValue);
  if (action === "recall-salvo")
    input.salvo = z.coerce
      .number()
      .int()
      .min(1)
      .max(type === "evertz-quartz" ? 32 : 8)
      .parse(values.actionValue);
  return { id, fields: input };
}

const RouterMatrixDestinationFields = z.object({
  actionId: z.string().min(1),
  actionColumnId: z.uuid(),
  contextId: z.uuid(),
  values: z.object({
    actionType: z.string(),
    actionGroup: z.union([z.uuid(), z.literal(""), z.null()]).optional(),
    enabled: z.boolean().optional(),
    actionValue: z.union([z.string(), z.number()]),
  }),
});

/** Read accepted Matrix configuration for local selection, without executing the row. */
export function routerMatrixDestination(
  type: RouterType,
  fields: ModuleValues,
): RouterMatrixDestinationRow | null {
  const input = RouterMatrixDestinationFields.safeParse(fields);
  if (
    !input.success ||
    input.data.values.enabled === false ||
    routerActionName(input.data.values.actionType) !== "select-destination"
  )
    return null;
  const { actionId, actionColumnId, contextId, values } = input.data;
  const parsed = parseModuleOrderedNumbers(
    values.actionValue,
    numbers(type === "aja-kumo" ? 64 : 65536),
  );
  if (!parsed.success) return null;
  const [first, ...rest] = parsed.values;
  if (first === undefined) return null;
  return {
    id: JSON.stringify([actionColumnId, actionId]),
    contextId,
    groupId: values.actionGroup || null,
    destinations: [first, ...rest],
  };
}

export function routerMatrixChoices(
  type: RouterType,
  manager: RouterConnectionManagerContract,
  groups: RouterGroupController,
  connectionId: string,
  query: ModuleChoiceQuery,
): ModuleChoicePage {
  if (query.provider === "matrix-actions") {
    const state = groups.snapshot();
    const context = state.contexts.find(
      (item) => item.reference.contextId === query.draft.contextId,
    );
    if (!context) throw new Error("Routing context is unavailable");
    const choices: ModuleChoice[] = [
      {
        id: "",
        label: "No action",
        values: { actionType: "", actionGroup: "" },
      },
    ];
    for (const group of context?.settings.groups.length
      ? context.settings.groups
      : [{ id: "", name: "" }])
      for (const action of grouped.filter(
        (action) => action !== "toggle-group-enabled" || group.id,
      ))
        choices.push({
          id: `${action}:${group.id}`,
          label: group.name
            ? `${labels[action]} — ${group.name}`
            : labels[action]!,
          ...(group.name ? { group: group.name } : {}),
          values: { actionType: action, actionGroup: group.id },
        });
    for (const action of routerActionNames(type).filter(
      (action) => action && !grouped.includes(action),
    ))
      choices.push({
        id: action,
        label: labels[action]!,
        values: { actionType: action, actionGroup: "" },
      });
    return choicePage(choices, query, {
      reference: context.reference,
      name: context.name,
      document: state.document?.revision,
    });
  }
  const action = routerActionName(query.draft.actionType);
  const snapshot = manager
    .snapshots()
    .find((item) => item.definition.connectionId === connectionId);
  if (query.provider === "matrix-value" && action === "recall-salvo") {
    const choices = Array.from(
      { length: type === "evertz-quartz" ? 32 : 8 },
      (_, index) => {
        const address = index + 1;
        return {
          id: String(address),
          label: `${address} — ${snapshot?.salvoCatalog?.find((item) => item.address === address)?.name ?? "Salvo"}`,
        };
      },
    ).filter((item) =>
      item.label.toLowerCase().includes(query.search.toLowerCase()),
    );
    return choicePage(choices, query);
  }
  if (
    !["matrix-value", "matrix-sources", "matrix-destinations"].includes(
      query.provider,
    )
  )
    throw new Error("Unknown router choice provider");
  const source =
    query.provider === "matrix-sources" ||
    (query.provider === "matrix-value" && action === "select-source");
  const request = {
    search: query.search || null,
    afterAddress: query.cursor
      ? z.coerce.number().int().min(1).max(65536).parse(query.cursor)
      : null,
    limit: query.limit,
  };
  const page = source
    ? manager.queryRouteSources(connectionId, request)
    : manager.queryRouteDestinations(connectionId, {
        ...request,
        source: null,
        levels: [],
      });
  return {
    revision: `${page.version.generation}:${page.labelRevision}`,
    choices: page.entries.map((item) => ({
      id: String(item.address),
      label: `${item.address} — ${item.label || "Unlabeled"}`,
    })),
    nextCursor:
      page.nextAfterAddress === null ? null : String(page.nextAfterAddress),
  };
}

function choicePage(
  choices: ModuleChoice[],
  query: ModuleChoiceQuery,
  context: unknown = null,
): ModuleChoicePage {
  const revision = createHash("sha256")
    .update(JSON.stringify([context, choices]))
    .digest("hex");
  const matching = choices.filter((choice) =>
    choice.label.toLowerCase().includes(query.search.trim().toLowerCase()),
  );
  const offset = query.cursor
    ? z.coerce.number().int().min(0).max(matching.length).parse(query.cursor)
    : 0;
  return {
    revision,
    choices: matching.slice(offset, offset + query.limit),
    nextCursor:
      offset + query.limit < matching.length
        ? String(offset + query.limit)
        : null,
  };
}

type RouterLabelCatalog = ManagedRouterConnectionSnapshot["sourceCatalog"];
const catalogIndexes = new WeakMap<
  RouterLabelCatalog,
  ReadonlyMap<number, string>
>();

function catalogLabel(
  catalog: RouterLabelCatalog | undefined,
  address: number,
): string {
  if (!catalog) return "Unlabeled";
  let labels = catalogIndexes.get(catalog);
  if (!labels) {
    labels = new Map(catalog.map(({ address, label }) => [address, label]));
    catalogIndexes.set(catalog, labels);
  }
  return labels.get(address) || "Unlabeled";
}

/** Resolve shared observations once, then render every row against that same view. */
export function createRouterMatrixFeedback(
  workspaceId: string,
  groups: RouterGroupController,
  snapshots: readonly ManagedRouterConnectionSnapshot[],
): (
  action: RouterActionDefinition,
) => Pick<ModuleFeedback, "state" | "observedAt" | "appearance"> {
  const contexts = new Map(
    groups.snapshot().contexts.map((item) => [item.reference.contextId, item]),
  );
  const byId = new Map(
    snapshots.map((item) => [item.definition.connectionId, item]),
  );
  const feedback = resolveRossGroupFeedback(
    workspaceId,
    groups.runtime.snapshots(),
    byId,
  );
  const observedAt = new Date().toISOString();
  return (action) => {
    const cells: NonNullable<
      NonNullable<ModuleFeedback["appearance"]>["cells"]
    > = {};
    const context =
      "moduleConnectionId" in action
        ? contexts.get(action.moduleConnectionId)
        : undefined;
    const snapshot = byId.get(action.connectionId);
    const actionName = routerActionName(action.type.split(".").at(-1));
    let groupId: string | null = null;
    let groupUnavailable = false;
    try {
      groupId =
        context && "groupId" in action
          ? resolveRouterGroup(context.settings, action.groupId)
          : null;
    } catch {
      // A stale group must not erase the action/address presentation. Execution
      // continues to validate the group independently before any router command.
      groupUnavailable = true;
    }
    const group = context?.settings.groups.find((item) => item.id === groupId);
    cells.actionType = {
      color: null,
      label:
        `${labels[actionName] ?? actionName}${group ? " — " + group.name : ""}`.slice(
          0,
          160,
        ),
    };
    const label = (address: number, source: boolean) =>
      `${address} — ${catalogLabel(source ? snapshot?.sourceCatalog : snapshot?.destinationCatalog, address)}`;
    if ("source" in action && actionName === "select-source")
      cells.actionValue = {
        color: null,
        label: label(action.source, true).slice(0, 160),
      };
    if ("destination" in action && actionName === "select-destination")
      cells.actionValue = {
        color: null,
        label: ("destinations" in action && action.destinations?.length
          ? action.destinations
          : [action.destination]
        )
          .map((address) => label(address, false))
          .join(", ")
          .slice(0, 160),
      };
    if (
      actionName === "route" &&
      "source" in action &&
      "destination" in action
    ) {
      cells.source = {
        color: null,
        label: label(action.source, true).slice(0, 160),
      };
      cells.destination = {
        color: null,
        label: label(action.destination, false).slice(0, 160),
      };
    }
    const neutral = {
      state: "inactive" as const,
      observedAt,
      appearance: { backgroundColor: null, cells },
    };
    if (groupUnavailable) return { ...neutral, state: "unavailable" };
    if (!action.enabled || !("drivesTally" in action) || !action.drivesTally)
      return neutral;
    if ("groupId" in action) {
      if (!context) return { ...neutral, state: "unavailable" };
      action = {
        ...action,
        groupId,
      } as RouterActionDefinition;
    }
    let active = false,
      color: string | null = null;
    switch (action.type) {
      case "ross-swp08.toggle-group-enabled":
      case "blackmagic-videohub.toggle-group-enabled":
      case "aja-kumo.toggle-group-enabled":
        active = feedback.groupIsEnabled(action);
        color = active ? action.feedbackColor : action.feedbackInactiveColor;
        break;
      case "ross-swp08.select-destination":
      case "blackmagic-videohub.select-destination":
      case "aja-kumo.select-destination":
        if (action.destinations) {
          const selected = feedback.selectedDestination(action),
            index =
              selected === null ? -1 : action.destinations.indexOf(selected);
          active = index >= 0;
          color = active
            ? (action.feedbackColors?.[index] ?? action.feedbackColor)
            : null;
          break;
        }
        active = feedback.selectedDestination(action) === action.destination;
        color = active ? action.feedbackColor : null;
        break;
      case "ross-swp08.select-source":
      case "blackmagic-videohub.select-source":
      case "aja-kumo.select-source":
      case "ross-swp08.take":
      case "blackmagic-videohub.take":
      case "aja-kumo.take":
        active = feedback.actionIsActive(action);
        color = active ? action.feedbackColor : null;
        break;
      case "ross-swp08.direct-route":
      case "blackmagic-videohub.direct-route":
      case "aja-kumo.direct-route":
        active =
          byId
            .get(action.connectionId)
            ?.routes.routes.get(action.destination)
            ?.get(
              action.type === "ross-swp08.direct-route"
                ? (action.levels[0] ?? 1)
                : 1,
            ) === action.source;
        color = active ? action.feedbackColor : null;
        break;
    }
    if (
      feedback.actionIsStaged(action) &&
      (color === null || ("destinations" in action && action.destinations))
    )
      color = "#FFC654";
    if (cells.actionValue) cells.actionValue = { ...cells.actionValue, color };
    return {
      state: active ? "active" : "inactive",
      observedAt,
      appearance: { backgroundColor: color, cells },
    };
  };
}
