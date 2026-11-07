import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  ModuleManifestSchema,
  type ModuleContext,
  type ModuleDocumentRequest,
  type ModuleExchange,
  type ModuleHostServices,
  type ModuleValues,
} from "@hubble/module-sdk";
import { actionSchemas as ajaActions } from "../../../modules/aja-kumo/src/actions.js";
import { ConnectionDefinitionSchema as ajaConnection } from "../../../modules/aja-kumo/src/config.js";
import aja from "../../../modules/aja-kumo/src/manifest.js";
import { actionSchemas as blackmagicActions } from "../../../modules/blackmagic-videohub/src/actions.js";
import { ConnectionDefinitionSchema as blackmagicConnection } from "../../../modules/blackmagic-videohub/src/config.js";
import blackmagic from "../../../modules/blackmagic-videohub/src/manifest.js";
import { actionSchemas as evertzActions } from "../../../modules/evertz-quartz/src/actions.js";
import { ConnectionDefinitionSchema as evertzConnection } from "../../../modules/evertz-quartz/src/config.js";
import evertz from "../../../modules/evertz-quartz/src/manifest.js";
import { actionSchemas as rossActions } from "../../../modules/ross-ultrix-ogp/src/actions.js";
import { ConnectionDefinitionSchema as rossConnection } from "../../../modules/ross-ultrix-ogp/src/config.js";
import ross from "../../../modules/ross-ultrix-ogp/src/manifest.js";
import type {
  RouterConnectionManagerContract,
  RouterDirectRouteSubmission,
} from "../src/connection-contract.js";
import { localRouterManager } from "../src/local-connection-manager.js";
import { routerSettings } from "../src/manifest.js";
import { routerModule } from "../src/module.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host refuses undeclared shared data and actions, so these packages must declare what the runtime offers. */
const routers = [
  ["aja-kumo", aja, { connection: ajaConnection, actions: ajaActions }],
  [
    "blackmagic-videohub",
    blackmagic,
    { connection: blackmagicConnection, actions: blackmagicActions },
  ],
  [
    "evertz-quartz",
    evertz,
    { connection: evertzConnection, actions: evertzActions },
  ],
  [
    "ross-ultrix-ogp",
    ross,
    { connection: rossConnection, actions: rossActions },
  ],
] as const;
type Router = (typeof routers)[number];

function parsedManifest(type: Router[0], source: Router[1]) {
  return ModuleManifestSchema.parse({
    ...source,
    id: `hubble-${type}`,
    name: type,
    version: "1.1.3",
    entry: "module.mjs",
    files: ["module.mjs", "ui/index.html", "ui/app.js"],
  });
}

const execution = () => ({
  executionId: randomUUID(),
  signal: new AbortController().signal,
  gesture: "press" as const,
  wrap: false,
  log: vi.fn(),
});

/** Connected and ready, without a network. */
function readyManager(
  submitDirectRouteTracked: RouterConnectionManagerContract["submitDirectRouteTracked"],
) {
  return (): RouterConnectionManagerContract => {
    const local = localRouterManager();
    return {
      ...local,
      snapshots: () =>
        local
          .snapshots()
          .map((item) => ({ ...item, routeTransport: "connected" as const })),
      routeState: (id) => ({ ...local.routeState(id), phase: "ready" }),
      submitDirectRouteTracked,
    };
  };
}

async function startedRouter(
  type: Router[0],
  source: Router[1],
  schemas: Router[2],
  options: {
    createManager?: () => RouterConnectionManagerContract;
    connectionEnabled?: boolean;
  } = {},
) {
  const manifest = parsedManifest(type, source);
  const publish = vi.fn(async (id: string, version: number, value: unknown) => {
    if (
      !manifest.exchange?.data.some(
        (item) => item.id === id && item.version === version,
      )
    )
      throw new Error("Shared data is not declared");
    return value;
  });
  const scope = {
    kind: "connection" as const,
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
  };
  const services = {
    request: async (
      service: string,
      _version: number,
      raw: unknown,
      signal?: AbortSignal,
    ) => {
      if ((raw as ModuleDocumentRequest).method === "watch")
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) reject(new Error("Cancelled"));
          else
            signal?.addEventListener(
              "abort",
              () => reject(new Error("Cancelled")),
              { once: true },
            );
        });
      if (service === "contexts")
        return { revision: "a".repeat(64), contexts: [] };
      return {
        status: "document",
        document: {
          workspaceId: scope.workspaceId,
          owner: {
            kind: "connection",
            connectionId: scope.connectionId,
            moduleId: manifest.id,
          },
          id: "routing-groups",
          version: 1,
          revision: null,
          value: { contexts: [] },
          canUndo: false,
          canRedo: false,
        },
      };
    },
  } as unknown as ModuleHostServices;
  const runtimeDirectory = await mkdtemp(
    path.join(tmpdir(), "router-readiness-"),
  );
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const log = vi.fn();
  const context: ModuleContext = {
    connectionEnabled: options.connectionEnabled ?? true,
    runtimeDirectory,
    scope,
    instanceId: randomUUID(),
    settings: Object.fromEntries(
      routerSettings(type).map(({ id, default: value }) => [
        id,
        id === "host" ? "127.0.0.1" : value,
      ]),
    ) as ModuleValues,
    services,
    modules: { publish } as unknown as ModuleExchange,
    log,
    publishFeedback: vi.fn(),
    publishState: vi.fn(),
    publishEvent: vi.fn(),
  };
  // The local manager keeps these tests off the network; the publication path is the same.
  const instance = routerModule(
    type,
    options.createManager ?? localRouterManager,
    schemas as Parameters<typeof routerModule>[2],
  ).createInstance(context);
  cleanups.push(async () => instance.dispose());
  await instance.start();
  await nextTurn();
  return { instance, log, publish, scope };
}

it.each(routers)(
  "%s declares exactly one queryable router readiness",
  (type, source) => {
    const data = parsedManifest(type, source).exchange?.data ?? [];
    expect(data.filter(({ id }) => id === "router")).toEqual([
      { id: "router", label: "Router readiness", version: 1, query: true },
    ]);
  },
);

it.each(routers)(
  "%s readiness publication is accepted and matches its query",
  async (type, source, schemas) => {
    const { instance, log, publish } = await startedRouter(
      type,
      source,
      schemas,
    );
    expect(publish).toHaveBeenCalledWith(
      "router",
      1,
      expect.objectContaining({ ready: false }),
    );
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: "publish-router" }),
    );
    // TALLY Switch accepts a provider only when it offers this data and parses `ready` from it.
    const [, , published] = publish.mock.calls.at(-1)!;
    expect(
      instance.queryData?.(
        { id: "router", version: 1, input: null },
        { signal: new AbortController().signal },
      ),
    ).toEqual(published);
  },
);

it.each(routers)(
  "%s offers the public route action TALLY Switch calls",
  (type, source) => {
    const manifest = parsedManifest(type, source);
    const route = manifest.actions.filter(({ id }) => id === "route");
    expect(route).toHaveLength(1);
    expect(route[0]?.legacy).toBeFalsy();
    expect(route[0]?.fields.map(({ id, required }) => [id, required])).toEqual([
      ["source", true],
      ["destination", true],
      ["level", true],
    ]);
    // The action's group label is shared presentation.
    expect(
      "minimumVersion" in manifest.host ? manifest.host.requiredFeatures : [],
    ).toContain("module-presentation-v1");
  },
);

it.each(routers)(
  "%s dispatches one route per request and never retries a rejection",
  async (type, source, schemas) => {
    const submit = vi.fn(
      (): RouterDirectRouteSubmission => ({
        submissionId: "route",
        accepted: Promise.resolve(),
        settled: Promise.resolve(),
      }),
    );
    const { instance, scope } = await startedRouter(type, source, schemas, {
      createManager: readyManager(submit),
    });
    const fields = { source: 3, destination: 2, level: 1 };
    await expect(
      instance.execute("route", fields, execution()),
    ).resolves.toMatchObject({
      status: "success",
      evidence: { kind: "submitted" },
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: scope.connectionId,
        source: 3,
        destination: 2,
        levels: [1],
      }),
    );
    submit.mockImplementationOnce(() => {
      const failed = Promise.reject(new Error("Destination locked"));
      return { submissionId: "route", accepted: failed, settled: failed };
    });
    await expect(
      instance.execute("route", fields, execution()),
    ).resolves.toMatchObject({
      status: "failure",
      category: "rejected",
      message: "Destination locked",
    });
    expect(submit).toHaveBeenCalledTimes(2);
  },
);

it.each(routers)(
  "%s refuses a route and publishes nothing while its connection is disabled",
  async (type, source, schemas) => {
    const createManager = vi.fn(localRouterManager);
    const { instance, publish } = await startedRouter(type, source, schemas, {
      createManager,
      connectionEnabled: false,
    });
    expect(createManager).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(
      instance.execute(
        "route",
        { source: 1, destination: 1, level: 1 },
        execution(),
      ),
    ).resolves.toMatchObject({
      status: "failure",
      category: "unavailable",
      message: "Router connection is disabled",
    });
  },
);
