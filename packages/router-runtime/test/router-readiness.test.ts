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
import { localRouterManager } from "../src/local-connection-manager.js";
import { routerSettings } from "../src/manifest.js";
import { routerModule } from "../src/module.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host refuses undeclared shared data, so these packages must declare what the runtime publishes. */
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

async function startedRouter(
  type: Router[0],
  source: Router[1],
  schemas: Router[2],
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
    connectionEnabled: true,
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
    localRouterManager,
    schemas as Parameters<typeof routerModule>[2],
  ).createInstance(context);
  cleanups.push(async () => instance.dispose());
  await instance.start();
  await nextTurn();
  return { instance, log, publish };
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
