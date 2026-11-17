import type { HubbleModule } from "@hubble/module-sdk";
import { createInstance } from "./instance.js";

export default {
  createInstance: (context) => createInstance(context),
} satisfies HubbleModule;
