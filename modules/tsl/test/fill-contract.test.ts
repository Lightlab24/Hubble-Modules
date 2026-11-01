import { expect, it } from "vitest";
import tsl from "../src/manifest.js";
import tally from "../../tally-switch/src/manifest.js";

it("increments address inputs in Matrix and mapping tables, leaving device identities alone", () => {
  expect(
    tsl.matrix?.fields.find((field) => field.id === "tallyAddress")?.fill,
  ).toBe("series");
  const mappings = tsl.pages
    ?.flatMap((page) => page.sections)
    .find((section) => section.id === "feedbackMappings");
  if (mappings?.type !== "table") throw new Error("Missing TSL mappings");
  for (const id of ["name", "address"])
    expect(mappings.workbook?.columns?.[id]?.fill).toBe("series");
  const routing = tally.pages
    ?.flatMap((page) => page.sections)
    .find((section) => section.id === "mappings");
  if (routing?.type !== "table") throw new Error("Missing routing mappings");
  const columns: Record<string, { fill?: string; width?: number }> =
    routing.workbook?.columns ?? {};
  for (const id of ["name", "address", "source"])
    expect(columns[id]?.fill).toBe("series");
  for (const id of ["receiver", "router", "destination", "screen", "level"])
    expect(columns[id]?.fill ?? "copy").toBe("copy");
});
