import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleExchange,
  ModuleExchangeNotification,
  ModuleJsonValue,
  ModulePeerBinding,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import {
  defaultRoutingDocument,
  ROUTING_DOCUMENT_ID,
  RoutingDocumentSchema,
  TslRouting,
  type RoutingDocument,
  type RoutingRow,
} from "../src/routing.js";

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const consumer = { kind: "connection" as const, connectionId: randomUUID(), moduleId: "hubble-tsl" };
const routerPeer = { kind: "connection" as const, connectionId: randomUUID(), moduleId: "hubble-ross-ultrix-ogp" };
const routerBinding: ModulePeerBinding = {
  id: randomUUID(),
  name: "Ross Ultrix OGP",
  consumer,
  target: routerPeer,
  allowActions: true,
};
const routerDescription: ModulePeerDescription = {
  peer: routerPeer,
  name: "Ross Ultrix OGP",
  available: true,
  actionsAllowed: true,
  data: [{ id: "router", label: "Router", version: 1, query: true }],
  actions: [],
};
/** Cameras 1 and 2 on TSL addresses 1 and 2, routed to output 2 from sources 21 and 22. */
const cameras: RoutingRow[] = [1, 2].map((address) => ({
  id: `camera-${address}`,
  name: `Camera ${address}`,
  enabled: true,
  screen: 0,
  address,
  indicator: "default",
  router: routerBinding.id,
  destination: 2,
  source: 20 + address,
  level: 1,
}));
/** What this module's own receiver shares: TSL 3.1, the camera on air has flag 2. */
const onAir = (camera: 0 | 1 | 2): ModuleJsonValue => ({
  phase: "listening",
  protocol: "3.1",
  displays: [1, 2].map((address, index) => [0, address, address === camera ? 2 : 0, 0, 0, 0, true, index + 1]),
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

async function world(options: { rows?: RoutingRow[]; runtimeDirectory?: string } = {}) {
  const runtimeDirectory = options.runtimeDirectory ?? (await mkdtemp(path.join(os.tmpdir(), "tsl-routing-")));
  if (!options.runtimeDirectory) cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  let saved = {
    id: ROUTING_DOCUMENT_ID,
    version: 1,
    revision: "rev-0" as string | null,
    value: { ...defaultRoutingDocument(), rows: options.rows ?? cameras } as RoutingDocument,
  };
  let writes = 0;
  let tally: ModuleJsonValue = onAir(0);
  const listeners = new Map<string, (event: ModuleExchangeNotification) => void | Promise<void>>();
  const route = vi.fn<ModuleExchange["execute"]>(async () => ({
    status: "success" as const,
    evidence: { kind: "submitted" as const, summary: "fixture" },
  }));
  const exchange: ModuleExchange = {
    discover: async () => [routerDescription],
    bindings: async () => [routerBinding],
    query: async () => null,
    subscribe: async (subscription, listener) => {
      if (subscription.kind !== "data") throw new Error("Unexpected filter");
      listeners.set(subscription.id, listener);
      return async () => {
        listeners.delete(subscription.id);
      };
    },
    publish: async () => {},
    execute: route,
    reportAction: async () => {},
  };
  const context = {
    scope: { kind: "connection", workspaceId: "w", connectionId: consumer.connectionId },
    instanceId: "i",
    runtimeDirectory,
    settings: {},
    modules: exchange,
    services: {
      async request(_service: string, _version: number, input: { method: string; expectedRevision?: string | null; value?: RoutingDocument }) {
        if (input.method === "write") {
          if (input.expectedRevision !== saved.revision) return { status: "conflict", document: saved };
          saved = { ...saved, revision: `rev-${++writes}`, value: structuredClone(input.value!) };
        }
        return { status: "document", document: saved };
      },
    },
    log: () => {},
    publishState: () => {},
    publishFeedback: () => {},
  } as unknown as ModuleContext;
  const changed = vi.fn();
  const routing = new TslRouting(context, () => tally, changed);
  cleanups.push(() => routing.close());
  const router = async (ready: boolean, generation = "router-1") =>
    listeners.get("router")?.({
      kind: "data",
      provider: routerPeer,
      generation,
      observedAt: new Date().toISOString(),
      id: "router",
      version: 1,
      value: { ready },
    });
  const setTally = async (value: ModuleJsonValue) => {
    tally = value;
    routing.tallyChanged();
    await settle();
  };
  const routed = () => route.mock.calls.map((call) => (call[2] as { source: number }).source);
  return { routing, route, routed, router, setTally, changed, runtimeDirectory, document: () => saved, setSaved: (rows: RoutingRow[]) => (saved = { ...saved, revision: `rev-${++writes}`, value: { rows } }) };
}

it("routes the camera that goes on air, from this module's own tally, while it follows", async () => {
  const test = await world();
  await test.setTally(onAir(1));
  await test.routing.start();
  await test.router(true);
  await settle();
  // Not following: nothing is routed, and the page says so for each camera.
  expect(test.route).not.toHaveBeenCalled();
  expect(test.routing.live().statuses).toEqual([
    { id: "camera-1", program: "ON AIR", status: "Unfollowing" },
    { id: "camera-2", program: "Off", status: "Unfollowing" },
  ]);
  expect(test.routing.live().routers).toEqual([{ id: routerBinding.id, label: "Ross Ultrix OGP", ready: true }]);

  // Following, chosen by the operator, catches up to the camera on air now.
  await expect(test.routing.follow("follow")).resolves.toBe(true);
  await settle();
  expect(test.routed()).toEqual([21]);
  expect(test.route.mock.calls[0]?.[0]).toEqual(routerPeer);
  expect(test.route.mock.calls[0]?.[1]).toBe("route");
  expect(test.route.mock.calls[0]?.[2]).toEqual({ source: 21, destination: 2, level: 1 });

  // A cut routes the new camera once; the same tally again routes nothing.
  await test.setTally(onAir(2));
  expect(test.routed()).toEqual([21, 22]);
  await test.setTally(onAir(2));
  expect(test.routed()).toEqual([21, 22]);
  expect(test.routing.live().statuses.find((status) => status.id === "camera-2")).toEqual({
    id: "camera-2",
    program: "ON AIR",
    status: "Submitted · source 22 → output 2",
  });
  expect(test.changed).toHaveBeenCalled();
});

it("holds the route it finds at startup, and when the router comes back", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "tsl-routing-"));
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  // Following was on when the module last ran.
  const first = await world({ runtimeDirectory });
  await first.routing.start();
  await first.routing.follow("follow");
  await first.routing.close();

  const test = await world({ runtimeDirectory });
  await test.setTally(onAir(1));
  await test.routing.start();
  await test.router(true);
  await settle();
  expect(test.routing.isFollowing()).toBe(true);
  // What is on air at startup is the baseline; only a change routes.
  expect(test.route).not.toHaveBeenCalled();
  await test.setTally(onAir(2));
  expect(test.routed()).toEqual([22]);

  // The router goes away and comes back: a cut it missed is not caught up.
  await test.router(false, "router-2");
  await test.setTally(onAir(1));
  await test.router(true, "router-3");
  await settle();
  expect(test.routed()).toEqual([22]);
  await test.setTally(onAir(2));
  expect(test.routed()).toEqual([22, 22]);
});

it("never repeats a route whose result was uncertain", async () => {
  const test = await world();
  await test.setTally(onAir(1));
  await test.routing.start();
  await test.router(true);
  test.route.mockResolvedValueOnce({ status: "failure", category: "unavailable", message: "Router did not answer" });
  await test.routing.follow("follow");
  await settle();
  expect(test.routed()).toEqual([21]);
  expect(test.routing.live().statuses[0]?.status).toBe("Route failed · Router did not answer");
  await test.setTally(onAir(1));
  expect(test.routed()).toEqual([21]);
});

it("holds an output with two cameras on air, or a camera with no router", async () => {
  const both: ModuleJsonValue = {
    phase: "listening",
    protocol: "3.1",
    displays: [1, 2].map((address, index) => [0, address, 2, 0, 0, 0, true, index + 1]),
  };
  const test = await world();
  await test.routing.start();
  await test.router(true);
  await test.routing.follow("follow");
  await test.setTally(both);
  expect(test.route).not.toHaveBeenCalled();
  expect(test.routing.live().statuses.map((status) => status.status)).toEqual([
    "Holding · multiple cameras on air",
    "Holding · multiple cameras on air",
  ]);
  const unrouted = await world({ rows: [{ ...cameras[0]!, router: "" }] });
  await unrouted.routing.start();
  await unrouted.routing.follow("follow");
  await unrouted.setTally(onAir(1));
  expect(unrouted.route).not.toHaveBeenCalled();
  expect(unrouted.routing.live().statuses[0]?.status).toBe("Holding · waiting for every mapped camera");
});

it("saves the camera mappings with the workspace, and routes by them at once", async () => {
  const test = await world();
  await test.setTally(onAir(1));
  await test.routing.start();
  await test.router(true);
  await test.routing.follow("follow");
  await settle();
  expect(test.routed()).toEqual([21]);
  const moved = cameras.map((row) => ({ ...row, source: row.source + 10 }));
  const saved = await test.routing.save(moved, test.document().revision, new AbortController().signal);
  expect(saved).toEqual({ status: "saved", rows: moved, revision: "rev-1" });
  expect(RoutingDocumentSchema.parse(test.document().value).rows).toEqual(moved);
  expect(test.routing.snapshot()).toMatchObject({ rows: moved, revision: "rev-1", following: true });
  // New mappings start from what is on air now, as a restart would; the next cut uses them.
  await test.setTally(onAir(2));
  expect(test.routed()).toEqual([21, 32]);

  // A save that lost a race hands back what is saved now and changes nothing.
  test.setSaved(cameras);
  const lost = await test.routing.save(moved, "rev-1", new AbortController().signal);
  expect(lost).toEqual({ status: "conflict", rows: cameras, revision: "rev-2" });
  // Two cameras with one ID, or a value the switcher can't hold, are refused before saving.
  await expect(test.routing.save([cameras[0]!, cameras[0]!], "rev-2", new AbortController().signal)).rejects.toThrow("same ID");
  await expect(test.routing.save([{ ...cameras[0]!, level: 0 }], "rev-2", new AbortController().signal)).rejects.toThrow();
  expect(test.document().revision).toBe("rev-2");
});

it("keeps Follow on this computer, not in the workspace", async () => {
  const test = await world();
  await test.routing.start();
  await test.routing.follow("toggle");
  expect(JSON.parse(await readFile(path.join(test.runtimeDirectory, "routing-following.json"), "utf8"))).toEqual({ following: true });
  await test.routing.follow("unfollow");
  expect(test.routing.isFollowing()).toBe(false);
  expect(test.document().value).not.toHaveProperty("following");
});

it("says so when there is no router to route to", async () => {
  const test = await world();
  (test.routing as unknown as { context: ModuleContext }).context.modules!.discover = async () => [];
  (test.routing as unknown as { context: ModuleContext }).context.modules!.bindings = async () => [];
  await test.routing.start();
  expect(test.routing.live()).toMatchObject({ routers: [], notice: "Add a router module to this workspace to route on tally" });
});

import manifest from "../src/manifest.js";
it("connects to every router with only route allowed, saves the cameras, and takes Tally Switch's place", () => {
  expect(manifest.exchange?.peers).toContainEqual({ data: "router", version: 1, actions: ["route"] });
  // Follow is this module's own now: it asks no other module.
  expect(manifest.exchange?.peers?.some((peer) => peer.data === "following")).toBe(false);
  expect(manifest.documents?.map((document) => document.id)).toEqual(["switcher", ROUTING_DOCUMENT_ID]);
  expect(manifest.pages?.[0]?.navigation).toEqual({ replaces: "tally-switch" });
  for (const feature of ["module-spreadsheet-controls-v1", "module-page-navigation-v1"])
    expect(manifest.host.requiredFeatures).toContain(feature);
  expect(manifest.pages?.[0]?.sections[0]).toMatchObject({
    commands: expect.arrayContaining([
      expect.objectContaining({ id: "routing-save" }),
      expect.objectContaining({ id: "routing-follow" }),
    ]),
  });
});
