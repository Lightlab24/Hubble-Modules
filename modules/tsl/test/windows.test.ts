import { expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { ModuleManifestSchema } from "@hubble/module-sdk";
import { PAGE_COMMANDS } from "../src/page.js";
import { isPageView, PAGE_VIEW_IDS, PAGE_VIEWS } from "../src/views.js";

// HubDash can show this page in several windows at once. e2e/windows.spec.ts runs two and three
// copies of the built page against the preview; this checks what the declaration rests on.
it("is declared live in every window, and only on a Hubble that has module windows", () => {
  const section = manifest.pages![0]!.sections[0]!;
  expect(section).toMatchObject({ type: "custom", windows: true, restart: "keep-open" });
  expect(manifest.host.requiredFeatures).toContain("module-page-windows-v1");
  // Following another window's saves needs its own command: it reads without waking every page.
  expect(PAGE_COMMANDS.map((command) => command.id)).toContain("saved");
  expect("commands" in section && section.commands?.map((command) => command.id)).toEqual(PAGE_COMMANDS.map((command) => command.id));
});

// Right-click TSL Tally in the sidebar, and Open in its own window › offers each view as a part
// (e2e/windows.spec.ts opens each one alone). HubDash saves a part's view with its window, and the
// page saves the same IDs as its open tab, so they come from one list.
it("lists Tally, Routing and Setup as the parts the sidebar opens in windows of their own", () => {
  const parsed = ModuleManifestSchema.parse({
    ...manifest,
    id: "hubble-tsl",
    name: "TSL Tally",
    version: "1.5.0",
    entry: "module.mjs",
    files: ["module.mjs", "ui/index.html", "ui/tsl.svg"],
  });
  const section = parsed.pages![0]!.sections[0]!;
  expect(section.type === "custom" && section.parts).toEqual([
    { view: "tally", title: "Tally" },
    { view: "routing", title: "Routing" },
    { view: "setup", title: "Setup" },
  ]);
  expect(PAGE_VIEWS.map((part) => part.view)).toEqual([...PAGE_VIEW_IDS]);
  expect(PAGE_VIEW_IDS.every(isPageView)).toBe(true);
  expect(["", "whole", "camera-3", "Tally", null].some(isPageView)).toBe(false);
});
