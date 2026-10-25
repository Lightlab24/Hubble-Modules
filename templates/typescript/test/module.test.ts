import { test } from "node:test";
import { assertModuleConformance } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
test("instance isolation, cancellation, evidence and cleanup", async () => {
  await assertModuleConformance({
    module,
    settings: { initialState: false },
    actionId: "set-state",
    fields: { active: true },
  });
});
