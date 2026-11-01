import type {
  ModuleFeedback,
  ModuleFeedbackSubscription,
  ModuleValues,
} from "@hubble/module-sdk";
import {
  KeyboardKeySchema,
  KeyboardModifiersSchema,
  parseSystemMenuPath,
} from "./schema/keyboard.js";

/** These are display labels only; the shared host retains original editable sources. */
export function systemFeedback(
  subscription: ModuleFeedbackSubscription,
  applications: ReadonlyMap<string, string>,
): ModuleFeedback {
  const raw = subscription.fields?.values;
  const values: ModuleValues =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as ModuleValues)
      : {};
  const cells: NonNullable<NonNullable<ModuleFeedback["appearance"]>["cells"]> =
    {};
  const app =
    typeof values.applicationBundleId === "string"
      ? applications.get(values.applicationBundleId)
      : undefined;
  if (app)
    cells.applicationBundleId = { label: app.slice(0, 160), color: null };
  if (
    values.actionType === "select-menu-item" &&
    typeof values.menuPath === "string"
  ) {
    const path = parseSystemMenuPath(values.menuPath);
    if (path)
      cells.menuPath = {
        label: path
          .map((item) => item.title)
          .join(" > ")
          .slice(0, 160),
        color: null,
      };
  }
  if (values.actionType === "send-shortcut") {
    const key = KeyboardKeySchema.safeParse(values.key);
    if (key.success)
      cells.key = {
        label: key.data
          .replace(/^Key/u, "")
          .replace(/^Digit/u, "")
          .replace(/([a-z])([A-Z])/gu, "$1 $2"),
        color: null,
      };
    const modifiers = KeyboardModifiersSchema.safeParse(values.modifiers);
    if (modifiers.success)
      cells.modifiers = {
        label:
          modifiers.data
            .split("+")
            .map(
              (value) =>
                ({
                  command: "Cmd",
                  control: "Ctrl",
                  option: "Option",
                  shift: "Shift",
                })[value] ?? value,
            )
            .filter(Boolean)
            .join(" + ") || "None",
        color: null,
      };
  }
  return {
    ...subscription,
    state: "inactive",
    observedAt: new Date().toISOString(),
    appearance: { cells },
  };
}
