import { ModuleMatrixSchema, type ModuleValues } from "@hubble/module-sdk";

export const systemCommands = [
  {
    value: "send-shortcut",
    label: "Keyboard Shortcut",
    id: "keyboard.send-shortcut",
  },
  {
    value: "activate-application",
    label: "Bring App to Front",
    id: "system.activate-application",
  },
  {
    value: "open-application",
    label: "Open App",
    id: "system.open-application",
  },
  {
    value: "select-menu-item",
    label: "Menu Command",
    id: "system.select-menu-item",
  },
] as const;
const shortcutOnly = [{ field: "actionType", values: ["send-shortcut"] }];
export const matrix = ModuleMatrixSchema.parse({
  id: "system-actions",
  label: "System Actions",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "actionType",
  context: true,
  workspaceContextTypes: ["keyboard"],
  legacy: { adapter: "keyboard", normalize: true },
  variants: systemCommands.map(({ value }) => ({
    when: [{ field: "column.commandId", values: [value] }],
    fields: { actionType: { default: value } },
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
      type: "choice",
      default: "send-shortcut",
      required: true,
      width: 230,
      choices: systemCommands.map(({ value, label }) => ({ value, label })),
    },
    {
      fill: "copy",
      id: "target",
      label: "Send To",
      type: "choice",
      default: "global",
      width: 200,
      enabledWhen: shortcutOnly,
      choices: [
        { value: "global", label: "Global (active application)" },
        { value: "application", label: "Specific application" },
      ],
    },
    {
      fill: "copy",
      id: "applicationBundleId",
      label: "Application",
      type: "text",
      default: "",
      width: 270,
      choiceProvider: "applications",
      emptyMessage: "No applications found. Enter a bundle ID.",
      rules: [
        {
          when: [
            { field: "actionType", values: ["send-shortcut"], negate: true },
          ],
          set: { required: true },
        },
        {
          when: [{ field: "target", values: ["application"] }],
          set: { required: true },
        },
      ],
    },
    {
      fill: "copy",
      id: "key",
      label: "Shortcut",
      type: "text",
      default: "",
      required: true,
      width: 200,
      shortcut: { modifiersField: "modifiers" },
      enabledWhen: shortcutOnly,
    },
    {
      fill: "copy",
      id: "modifiers",
      label: "Modifiers",
      type: "text",
      default: "",
      width: 200,
      enabledWhen: shortcutOnly,
    },
    {
      fill: "copy",
      id: "menuPath",
      label: "Menu command",
      type: "text",
      default: "",
      required: true,
      width: 300,
      enabledWhen: [{ field: "actionType", values: ["select-menu-item"] }],
      choiceProvider: "menu-commands",
      choiceFields: ["menuPath"],
      emptyMessage: "Choose a running application, then select a menu command.",
    },
  ],
});
export function matrixAction(fields: ModuleValues): {
  id: string;
  fields: ModuleValues;
} {
  const raw = fields.values;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("System action fields are unavailable");
  const values = raw as ModuleValues;
  const command = systemCommands.find(
    (item) => item.value === values.actionType,
  );
  if (!command) throw new Error("Choose a system action");
  return {
    id: command.id,
    fields: {
      applicationBundleId: values.applicationBundleId ?? "",
      ...(command.value === "send-shortcut"
        ? {
            target: values.target ?? "global",
            key: values.key ?? "",
            modifiers: values.modifiers ?? "",
          }
        : {}),
      ...(command.value === "select-menu-item"
        ? { menuPath: values.menuPath ?? "" }
        : {}),
    },
  };
}
