import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { actions, feedback, matrix } from "./actions.js";
import { settings } from "./config.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.2.0",
    requiredFeatures: ["module-fields-v2", "module-matrix-v1", "module-feedback-observers-v1"],
  },
  configVersion: 1,
  capabilities: [],
  settings,
  actions: [...actions],
  feedback,
  matrix,
});
