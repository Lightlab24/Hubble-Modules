import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { settings } from "./config.js";
import { actions } from "./actions.js";
import { feedback } from "./feedback.js";
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: { minimumVersion: "2.0.0" },
  configVersion: 1,
  capabilities: [],
  settings,
  actions: [...actions],
  feedback,
});
