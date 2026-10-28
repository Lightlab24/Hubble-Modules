import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { KEYBOARD_KEYS } from "./schema/keyboard.js";

const application = {
  id: "applicationBundleId",
  label: "Application bundle ID",
  type: "text" as const,
  required: true,
  default: "",
  description: "The application to control, for example com.apple.finder.",
};
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.0",
    requiredFeatures: ["host-services-v1", "module-workspace-actions-v1"],
  },
  configVersion: 1,
  capabilities: ["host.keyboard"],
  settings: [],
  actions: [
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
        { ...application, required: false },
        {
          id: "key",
          label: "Key",
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
      fields: [application],
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
  feedback: [],
});
