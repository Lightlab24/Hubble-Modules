import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { matrix } from "./matrix.js";
import { KEYBOARD_KEYS } from "./schema/keyboard.js";

const application = {
  id: "applicationBundleId",
  label: "Application bundle ID",
  type: "choice" as const,
  choices: [],
  choiceProvider: "applications",
  required: true,
  default: "",
  description: "The application to control, for example com.apple.finder.",
};
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "host-services-v1",
      "module-workspace-actions-v1",
      "module-contexts-v1",
      "module-workspace-contexts-v1",
      "host-service-registry-v1",
      "module-native-controls-v1",
      "module-workspace-instances-v1",
      "module-workspace-matrix-choices-v1",
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-matrix-context-v1",
      "module-matrix-row-fields-v1",
      "module-shortcut-editor-v1",
      "module-choice-bindings-v1",
      "module-choices-v2",
      "module-fields-v2",
    ],
  },
  configVersion: 1,
  instanceScope: "workspace",
  matrix,
  capabilities: ["host.keyboard"],
  settings: [],
  actions: [
    {
      id: "matrix",
      label: "System Actions Matrix",
      description: "Module-owned native action choices and fields.",
      completion: "response",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "keyboard.send-shortcut",
      label: "Send keyboard shortcut",
      description: "Send a shortcut through the native automation bridge.",
      completion: "response",
      timeoutMs: 120000,
      fields: [
        {
          id: "target",
          label: "Target",
          type: "choice",
          required: true,
          default: "global",
          choices: [
            { id: "global", label: "Active application" },
            { id: "application", label: "Selected application" },
          ],
        },
        {
          ...application,
          required: true,
          visibleWhen: [{ field: "target", equals: "application" }],
        },
        {
          id: "key",
          label: "Shortcut",
          shortcut: { modifiersField: "modifiers" },
          type: "choice",
          required: true,
          default: "KeyA",
          choices: KEYBOARD_KEYS.map((id) => ({
            id,
            label: id.startsWith("Key")
              ? id.slice(3)
              : id.startsWith("Digit")
                ? id.slice(5)
                : id,
          })),
        },
        {
          id: "modifiers",
          label: "Modifiers",
          type: "text",
          required: false,
          default: "",
          description:
            "Combine command, control, option and shift with +, for example command+shift.",
        },
      ],
    },
    {
      id: "system.activate-application",
      label: "Activate application",
      description: "Bring a running application to the foreground.",
      completion: "response",
      timeoutMs: 120000,
      fields: [application],
    },
    {
      id: "system.open-application",
      label: "Open application",
      description: "Open an application through the native automation bridge.",
      completion: "response",
      timeoutMs: 120000,
      fields: [{ ...application, choiceProvider: "installed-applications" }],
    },
    {
      id: "system.select-menu-item",
      label: "Select menu command",
      description: "Choose a command in the application menu.",
      completion: "response",
      timeoutMs: 120000,
      fields: [
        application,
        {
          id: "menuPath",
          label: "Menu command",
          type: "text",
          required: true,
          default: "",
          description:
            "Separate menu levels with >, for example File > Open. Saved menu selections remain supported.",
        },
      ],
    },
  ],
  feedback: [
    {
      id: "matrix",
      label: "System Action Status",
      description:
        "Native actions have response evidence, not continuous selected state.",
      fields: [],
    },
  ],
});
