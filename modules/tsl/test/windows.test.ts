import { expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PAGE_COMMANDS } from "../src/page.js";

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
