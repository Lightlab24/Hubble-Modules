import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ModuleManifestSchema,
  moduleFieldDefault,
  moduleFieldVisible,
  validateModuleFields,
  type ModuleContext,
  type ModuleDocumentRequest,
  type ModuleExchange,
  type ModuleHostServices,
  type ModuleValues,
} from "@hubble/module-sdk";
import { ModuleDataAssembler } from "@hubble/module-contracts/observations";
import { actionSchemas as ajaActions } from "../../../modules/aja-kumo/src/actions.js";
import { AjaKumoConnectionManager } from "../../../modules/aja-kumo/src/aja-kumo-connection-manager.js";
import { ConnectionDefinitionSchema as ajaConnection } from "../../../modules/aja-kumo/src/config.js";
import aja from "../../../modules/aja-kumo/src/manifest.js";
import { actionSchemas as blackmagicActions } from "../../../modules/blackmagic-videohub/src/actions.js";
import { BlackmagicVideohubConnectionManager } from "../../../modules/blackmagic-videohub/src/blackmagic-videohub-connection-manager.js";
import { ConnectionDefinitionSchema as blackmagicConnection } from "../../../modules/blackmagic-videohub/src/config.js";
import blackmagic from "../../../modules/blackmagic-videohub/src/manifest.js";
import { actionSchemas as evertzActions } from "../../../modules/evertz-quartz/src/actions.js";
import { ConnectionDefinitionSchema as evertzConnection } from "../../../modules/evertz-quartz/src/config.js";
import { EvertzQuartzConnectionManager } from "../../../modules/evertz-quartz/src/evertz-quartz-connection-manager.js";
import evertz from "../../../modules/evertz-quartz/src/manifest.js";
import { actionSchemas as rossActions } from "../../../modules/ross-ultrix-ogp/src/actions.js";
import { ConnectionDefinitionSchema as rossConnection } from "../../../modules/ross-ultrix-ogp/src/config.js";
import { RossUltrixOgpConnectionManager } from "../../../modules/ross-ultrix-ogp/src/ross-ultrix-ogp-connection-manager.js";
import ross from "../../../modules/ross-ultrix-ogp/src/manifest.js";
import type { RouterConnectionManagerContract } from "../src/connection-contract.js";
import { routerSettings } from "../src/manifest.js";
import { routerLabels } from "../src/matrix.js";
import { routerModule } from "../src/module.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const routers = [
  [
    "aja-kumo",
    aja,
    { connection: ajaConnection, actions: ajaActions },
    () => new AjaKumoConnectionManager(),
  ],
  [
    "blackmagic-videohub",
    blackmagic,
    { connection: blackmagicConnection, actions: blackmagicActions },
    () => new BlackmagicVideohubConnectionManager(),
  ],
  [
    "evertz-quartz",
    evertz,
    { connection: evertzConnection, actions: evertzActions },
    () => new EvertzQuartzConnectionManager(),
  ],
  [
    "ross-ultrix-ogp",
    ross,
    { connection: rossConnection, actions: rossActions },
    () => new RossUltrixOgpConnectionManager(),
  ],
] as const;
type Router = (typeof routers)[number];

const defaults = (type: Router[0]): ModuleValues =>
  Object.fromEntries(
    routerSettings(type).map((field) => [field.id, moduleFieldDefault(field)]),
  ) as ModuleValues;

const deviceFields = (type: Router[0]) => [
  "host",
  "port",
  "requestTimeoutMs",
  "reconnectDelayMs",
  ...(type === "aja-kumo" ? ["password"] : []),
  ...(type === "evertz-quartz" ? ["refreshIntervalSeconds"] : []),
];

it.each(routers)(
  "%s offers Simulated first and hides the device address and timing while it is on",
  (type, source) => {
    const settings = routerSettings(type);
    expect(settings[0]).toEqual({
      id: "simulated",
      label: "Simulated",
      type: "boolean",
      default: false,
      required: false,
      description: `Runs a stand-in ${routerLabels[type]} inside Hubble. Nothing goes on the network. Buttons route it and tally lights as on a real router.`,
    });
    const simulated = { ...defaults(type), simulated: true };
    const real = { ...defaults(type), simulated: false };
    for (const field of settings) {
      const hidden = deviceFields(type).includes(field.id);
      expect(moduleFieldVisible(field, simulated), field.id).toBe(!hidden);
      expect(moduleFieldVisible(field, real), field.id).toBe(true);
    }
    // Sources, Destinations, Levels and the Quartz level system size the simulated router.
    const visible = settings
      .filter((field) => moduleFieldVisible(field, simulated))
      .map(({ id }) => id);
    expect(visible).toEqual(
      expect.arrayContaining(["simulated", "sourceLimit", "destinationLimit"]),
    );
    if (type === "evertz-quartz" || type === "ross-ultrix-ogp")
      expect(visible).toContain("levels");
    if (type === "evertz-quartz") expect(visible).toContain("levelSystem");

    // The host checks settings with the same rule: a hidden Host isn't required.
    expect(() =>
      validateModuleFields(settings, { ...defaults(type), simulated: true }),
    ).not.toThrow();
    expect(() =>
      validateModuleFields(settings, { ...defaults(type), simulated: false }),
    ).toThrow("Enter the router hostname or IP address");
    const { simulated: _omitted, ...saved } = defaults(type);
    expect(() => validateModuleFields(settings, saved)).toThrow(
      "Enter the router hostname or IP address",
    );
    expect(() =>
      validateModuleFields(settings, { ...saved, host: "10.0.0.1" }),
    ).not.toThrow();

    // The published manifest still validates, and visibility rules stay within module-fields-v2.
    const manifest = ModuleManifestSchema.parse({
      ...source,
      id: `hubble-${type}`,
      name: type,
      version: "1.1.3",
      entry: "module.mjs",
      files: [
        "module.mjs",
        "ui/index.html",
        "ui/settings.html",
        "ui/app.js",
        ...(type === "ross-ultrix-ogp" ? ["ui/logo.svg"] : []),
      ],
    });
    expect(manifest.settings?.[0]?.id).toBe("simulated");
    expect(
      "minimumVersion" in manifest.host ? manifest.host.requiredFeatures : [],
    ).toContain("module-fields-v2");
  },
);

async function startedSimulatedRouter(
  type: Router[0],
  source: Router[1],
  schemas: Router[2],
  createManager: () => RouterConnectionManagerContract,
) {
  const manifest = ModuleManifestSchema.parse({
    ...source,
    id: `hubble-${type}`,
    name: type,
    version: "1.1.3",
    entry: "module.mjs",
    files: [
      "module.mjs",
      "ui/index.html",
      "ui/settings.html",
      "ui/app.js",
      ...(type === "ross-ultrix-ogp" ? ["ui/logo.svg"] : []),
    ],
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
    path.join(tmpdir(), "router-simulated-"),
  );
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const publishState = vi.fn();
  const publishEvent = vi.fn();
  const context: ModuleContext = {
    connectionEnabled: true,
    runtimeDirectory,
    scope,
    instanceId: randomUUID(),
    // As Hubble saves a new simulated connection: every default, Simulated on, Host left empty.
    settings: { ...defaults(type), simulated: true },
    services,
    modules: {
      publish: vi.fn(async (_id: string, _version: number, value: unknown) => value),
    } as unknown as ModuleExchange,
    log: vi.fn(),
    publishFeedback: vi.fn(),
    publishState,
    publishEvent,
  };
  const instance = routerModule(
    type,
    createManager,
    schemas as Parameters<typeof routerModule>[2],
  ).createInstance(context);
  cleanups.push(async () => instance.dispose());
  await instance.start();
  return { instance, publishState, publishEvent, scope };
}

const execution = () => ({
  executionId: randomUUID(),
  signal: new AbortController().signal,
  gesture: "press" as const,
  wrap: false,
  log: vi.fn(),
});

it.each(routers)(
  "%s with Simulated on reports Simulated, routes and confirms through the whole module",
  async (type, source, schemas, createManager) => {
    const { instance, publishState, publishEvent } =
      await startedSimulatedRouter(type, source, schemas, createManager);

    // Ready once connected, marked simulated for Hubble's status.
    await vi.waitFor(() =>
      expect(publishState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          phase: "ready",
          message: "Simulated router",
          values: expect.objectContaining({ simulated: true }),
        }),
      ),
    );
    expect(
      instance.queryData?.(
        { id: "router", version: 1, input: null },
        { signal: new AbortController().signal },
      ),
    ).toMatchObject({ ready: true });

    // The Router page learns it is simulated, with the size the settings give.
    const page = (await instance.call!(
      "page.routing",
      { sectionId: "router", commandId: "settings", value: null },
      execution(),
    )) as { connection: Record<string, unknown> };
    expect(page.connection).toMatchObject({
      simulated: true,
      host: "",
      status: "connected",
    });

    // A watched destination follows a route made by a button's action.
    const id = randomUUID();
    await instance.call!(
      "watch",
      { id, destination: 2, levels: [1] },
      execution(),
    );
    await expect(
      instance.execute(
        "route",
        { source: 3, destination: 2, level: 1 },
        execution(),
      ),
    ).resolves.toMatchObject({ status: "success" });
    await vi.waitFor(() => {
      const assembler = new ModuleDataAssembler();
      const watches = publishEvent.mock.calls
        .filter(([channel]) => channel === "router.watch")
        .flatMap(([, chunk]) => {
          const result = assembler.accept(chunk);
          return result.complete ? [result.value] : [];
        }) as { id: string; snapshot: { phase: string; sourcesByLevel: Map<number, number> } }[];
      expect(watches.at(-1)).toMatchObject({
        id,
        snapshot: { phase: "ready", sourcesByLevel: new Map([[1, 3]]) },
      });
    });
  },
);
