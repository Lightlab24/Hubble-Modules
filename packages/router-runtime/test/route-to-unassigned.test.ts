import { describe, expect, it, vi } from "vitest";
import { executeRouteRequest } from "../src/multi-level-commands.js";
import { validateRouteRequest } from "../src/multi-level-validation.js";
import { RouterExpectedSourceSchema } from "../src/page-contract.js";

const mappingId = "22222222-2222-4222-8222-222222222222";

function setup(type: string, routed: number | null) {
  const setCrosspoint = vi.fn(() => Promise.resolve());
  const generation = "33333333-3333-4333-8333-333333333333";
  const entry = {
    phase: "connected",
    routing: { snapshot: () => ({ version: { generation }, phase: "ready" }) },
    definition: { type, sourceLimit: 100, destinationLimit: 100, levels: 2 },
    routes: {
      routes: new Map(routed === null ? [] : [[13, new Map([[1, routed]])]]),
    },
    client: { setCrosspoint },
  } as never;
  const runtime = {
    assertConnected: () => undefined,
    synchronizeAfterCommand: () => undefined,
    emit: () => undefined,
    entryConnected: () => true,
    isCurrentEntry: () => true,
  };
  const request = {
    operationId: "11111111-1111-4111-8111-111111111111",
    version: { generation, revision: 1 },
    mappings: [
      {
        mappingId,
        source: 7,
        destination: 13,
        levels: [1],
        expected: [{ level: 1, source: null }],
      },
    ],
  } as never;
  return { entry, runtime, request, setCrosspoint };
}

describe("routing to an unassigned destination", () => {
  it("lets a route say it expects nothing to be routed there", () => {
    expect(
      RouterExpectedSourceSchema.parse({ level: 1, source: null }),
    ).toEqual({ level: 1, source: null });
  });

  it("sends when the Ross destination is still unassigned", async () => {
    const { entry, runtime, request, setCrosspoint } = setup(
      "ross-ultrix-ogp",
      null,
    );
    const result = await executeRouteRequest(runtime, "c", entry, 0, request);
    expect(setCrosspoint).toHaveBeenCalledWith({
      source: 7,
      destination: 13,
      levels: [1],
    });
    expect(JSON.stringify(result)).toContain("acknowledged");
  });

  it("refuses when something was routed there in the meantime", async () => {
    const { entry, runtime, request, setCrosspoint } = setup(
      "ross-ultrix-ogp",
      5,
    );
    const result = await executeRouteRequest(runtime, "c", entry, 0, request);
    expect(setCrosspoint).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("conflict");
  });

  it("is only accepted from a router that reports empty destinations", () => {
    const ross = setup("ross-ultrix-ogp", null);
    const quartz = setup("evertz-quartz", null);
    expect(validateRouteRequest(ross.entry, ross.request)).not.toBe(
      "invalid_source",
    );
    expect(validateRouteRequest(quartz.entry, quartz.request)).toBe(
      "invalid_source",
    );
  });
});
