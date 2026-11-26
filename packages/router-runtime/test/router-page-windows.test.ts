import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  moduleFieldDefault,
  type ModuleContext,
  type ModuleDocumentRequest,
  type ModuleExchange,
  type ModuleHostServices,
  type ModuleValues,
} from "@hubble/module-sdk";
import { FakeVideohubServer } from "@hubble/protocol-videohub/fake-server";
import { actionSchemas as ajaActions } from "../../../modules/aja-kumo/src/actions.js";
import { AjaKumoConnectionManager } from "../../../modules/aja-kumo/src/aja-kumo-connection-manager.js";
import { ConnectionDefinitionSchema as ajaConnection } from "../../../modules/aja-kumo/src/config.js";
import { actionSchemas as blackmagicActions } from "../../../modules/blackmagic-videohub/src/actions.js";
import { BlackmagicVideohubConnectionManager } from "../../../modules/blackmagic-videohub/src/blackmagic-videohub-connection-manager.js";
import { ConnectionDefinitionSchema as blackmagicConnection } from "../../../modules/blackmagic-videohub/src/config.js";
import { actionSchemas as evertzActions } from "../../../modules/evertz-quartz/src/actions.js";
import { ConnectionDefinitionSchema as evertzConnection } from "../../../modules/evertz-quartz/src/config.js";
import { EvertzQuartzConnectionManager } from "../../../modules/evertz-quartz/src/evertz-quartz-connection-manager.js";
import { actionSchemas as rossActions } from "../../../modules/ross-ultrix-ogp/src/actions.js";
import { ConnectionDefinitionSchema as rossConnection } from "../../../modules/ross-ultrix-ogp/src/config.js";
import { RossUltrixOgpConnectionManager } from "../../../modules/ross-ultrix-ogp/src/ross-ultrix-ogp-connection-manager.js";
import type { RouterConnectionManagerContract } from "../src/connection-contract.js";
import type { RouterType } from "../src/matrix.js";
import { routerSettings, withRouterInterface } from "../src/manifest.js";
import { routerModule, routerViewPreferences } from "../src/module.js";
import { createRouterPageApi } from "../src/frontend/page-client.js";
import {
  createRouterState,
  reduceRouterEvent,
  sourceAt,
  type RouterState,
} from "../src/frontend/router-state.js";
import {
  ButtonMatrixSettingsModel,
  followRoutingRevision,
  type ButtonMatrixSettingsRow,
} from "../src/frontend/button-matrix-settings.js";

/*
 * HubDash can show the Router page in several windows at once, each its own copy of the page
 * talking to one running module. These run the page's own client code (the session client, the
 * route reducer and the Button Matrix settings model) as two or more copies against one router
 * module and a fake Videohub on this computer. Nothing reaches a real router.
 */

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const VIDEO = 1;
const blockUntilAborted = (signal?: AbortSignal) =>
  new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new Error("Cancelled"));
    signal?.addEventListener("abort", () => reject(new Error("Cancelled")), {
      once: true,
    });
  });

/** Hubble's document store as a module sees it: every save has a new revision and a save from an older one is refused. */
function documentStore(
  scope: { workspaceId: string; connectionId: string },
  moduleId: string,
  initial: Record<string, unknown>,
) {
  const saved = new Map(
    Object.entries(initial).map(([id, value]) => [
      id,
      { revision: null as string | null, value },
    ]),
  );
  const moved = new Set<() => void>();
  const snapshot = (id: string) => ({
    workspaceId: scope.workspaceId,
    owner: { kind: "connection", connectionId: scope.connectionId, moduleId },
    id,
    version: 1,
    revision: saved.get(id)!.revision,
    value: structuredClone(saved.get(id)!.value),
    canUndo: false,
    canRedo: false,
  });
  return {
    value: (id: string) => saved.get(id)!.value,
    async request(input: ModuleDocumentRequest, signal?: AbortSignal) {
      if (input.method === "list") throw new Error("Not used by routers");
      const document = saved.get(input.id);
      if (!document) throw new Error(`Unknown document ${input.id}`);
      if (input.method === "watch") {
        // Answers once the document has moved on from the revision the module holds.
        while (document.revision === input.afterRevision)
          await new Promise<void>((resolve, reject) => {
            const wake = () => {
              moved.delete(wake);
              resolve();
            };
            moved.add(wake);
            blockUntilAborted(signal).catch((error: unknown) => {
              moved.delete(wake);
              reject(error as Error);
            });
          });
        return { status: "document", document: snapshot(input.id) };
      }
      if (input.method === "write") {
        if (input.expectedRevision !== document.revision)
          return { status: "conflict", document: snapshot(input.id) };
        document.value = structuredClone(input.value);
        document.revision = randomUUID();
        for (const wake of [...moved]) wake();
      }
      return { status: "document", document: snapshot(input.id) };
    },
  };
}

/** The four router modules share this page. Each runs here with its own connection manager. */
const routers = [
  ["aja-kumo", () => new AjaKumoConnectionManager(), { connection: ajaConnection, actions: ajaActions }],
  ["blackmagic-videohub", () => new BlackmagicVideohubConnectionManager(), { connection: blackmagicConnection, actions: blackmagicActions }],
  ["evertz-quartz", () => new EvertzQuartzConnectionManager(), { connection: evertzConnection, actions: evertzActions }],
  ["ross-ultrix-ogp", () => new RossUltrixOgpConnectionManager(), { connection: rossConnection, actions: rossActions }],
] as const satisfies readonly (readonly [RouterType, () => RouterConnectionManagerContract, unknown])[];

type Router = Awaited<ReturnType<typeof startRouter>>;

/**
 * One router module connection. By default a Videohub on a fake Videohub with eight inputs and
 * eight outputs; `simulated` runs the module's own Simulated router instead.
 */
async function startRouter(
  options: {
    readonly routeAcknowledgementDelayMs?: number;
    readonly simulated?: readonly [
      RouterType,
      () => RouterConnectionManagerContract,
      unknown,
    ];
  } = {},
) {
  const [type, createManager, schemas] = options.simulated ?? routers[1];
  const fake = options.simulated
    ? null
    : await FakeVideohubServer.start({
        sourceCount: 8,
        destinationCount: 8,
        ...(options.routeAcknowledgementDelayMs === undefined
          ? {}
          : { routeAcknowledgementDelayMs: options.routeAcknowledgementDelayMs }),
      });
  if (fake) cleanups.push(() => fake.close());
  const scope = {
    kind: "connection" as const,
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
  };
  const alias = {
    name: "Videohub",
    reference: {
      kind: "hubble-context-reference",
      formatVersion: 1,
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      contextId: randomUUID(),
      unresolved: false,
    },
  };
  const store = documentStore(scope, `hubble-${type}`, {
    "routing-groups": { contexts: [] },
    "router-view": { zoom: 100 },
  });
  const services = {
    request: async (
      service: string,
      _version: number,
      raw: unknown,
      signal?: AbortSignal,
    ) => {
      const input = raw as ModuleDocumentRequest;
      if (service === "contexts")
        return input.method === "watch"
          ? blockUntilAborted(signal)
          : { revision: "a".repeat(64), contexts: [structuredClone(alias)] };
      if (service !== "documents")
        throw new Error(`Unexpected service ${service}`);
      return store.request(input, signal);
    },
  } as unknown as ModuleHostServices;
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), "router-windows-"));
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  // Like HubDash, every open copy of the page is handed the module's state when it changes.
  const pages = new Set<(state: unknown) => void>();
  let latest: unknown;
  const context: ModuleContext = {
    connectionEnabled: true,
    runtimeDirectory,
    scope,
    instanceId: randomUUID(),
    settings: {
      ...(Object.fromEntries(
        routerSettings(type).map((field) => [field.id, moduleFieldDefault(field)]),
      ) as ModuleValues),
      ...(fake
        ? { simulated: false, host: "127.0.0.1", port: fake.port }
        : { simulated: true }),
    },
    services,
    modules: {
      publish: vi.fn(async (_id: string, _version: number, value: unknown) => value),
    } as unknown as ModuleExchange,
    log: vi.fn(),
    publishFeedback: vi.fn(),
    publishState: (state) => {
      latest = state;
      setTimeout(() => {
        for (const deliver of pages) deliver(state);
      }, 0);
    },
    publishEvent: vi.fn(),
  };
  const instance = routerModule(
    type,
    createManager,
    schemas as Parameters<typeof routerModule>[2],
  ).createInstance(context);
  cleanups.push(() => instance.dispose());
  await instance.start();
  // The router is connected and its routes are read.
  await vi.waitFor(
    () => {
      expect(latest).toMatchObject({ phase: "ready" });
    },
    { timeout: 5000 },
  );
  return {
    fake: fake!,
    instance,
    store,
    connectionId: scope.connectionId,
    pages,
    latest: () => latest,
  };
}

type PageCopy = Awaited<ReturnType<typeof openPage>>;

/**
 * One copy of the Router page, in one window, wired the way the page wires itself. `close` is
 * the page closing itself; `windowClosed` is HubDash closing the window, which ends the page's
 * requests in flight without the page getting a word in.
 */
async function openPage(router: Router) {
  const lifetime = new AbortController();
  const listeners = new Set<(state: unknown) => void>();
  let latest: unknown;
  let delivered = "";
  const deliver = (state: unknown) => {
    const text = JSON.stringify(state);
    if (text === delivered) return;
    delivered = text;
    latest = state;
    for (const listener of listeners) listener(state);
  };
  const bridge = {
    // Like the page's own bridge, a request after the window closed is refused, not thrown.
    call: async (commandId: string, value: unknown = null) => {
      lifetime.signal.throwIfAborted();
      return router.instance.call!(
        "page.routing",
        { sectionId: "router", commandId, value } as never,
        { signal: lifetime.signal, log: vi.fn() },
      );
    },
    subscribe(listener: (state: unknown) => void) {
      listeners.add(listener);
      if (latest !== undefined) listener(latest);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const failures: string[] = [];
  const resyncs: string[] = [];
  let rows: readonly ButtonMatrixSettingsRow[] = [];
  const settings = new ButtonMatrixSettingsModel(
    bridge as never,
    (next) => {
      rows = next;
    },
    (message) => failures.push(message),
    randomUUID,
  );
  const reload = () =>
    void settings.load().catch((error: unknown) => failures.push(String(error)));
  // The Router page reloads its settings when the session reports new groups,
  // and the settings follow the published routing revision on their own.
  let groupRevision = "initial";
  const api = createRouterPageApi(bridge as never, (_connection, revision) => {
    if (revision === undefined || revision === groupRevision) return;
    groupRevision = revision;
    reload();
  });
  let state!: RouterState;
  router.pages.add(deliver);
  const stopFollowing = bridge.subscribe(followRoutingRevision(reload));
  if (router.latest() !== undefined) deliver(router.latest());
  try {
    const bootstrap = await api.connectRouterState(
      router.connectionId,
      (event) => {
        const reduction = reduceRouterEvent(state, event);
        state = reduction.state;
        if (reduction.effect === "resync")
          resyncs.push(
            event.event.type === "resync_required"
              ? event.event.reason
              : event.event.type,
          );
      },
    );
    state = createRouterState(bootstrap);
  } catch (error) {
    router.pages.delete(deliver);
    stopFollowing();
    throw error;
  }
  await settings.load();
  // The page asks for its next events as soon as it opens, and from then on always has that
  // request waiting at the module.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const copy = {
    bridge,
    settings,
    failures,
    resyncs,
    get rows() {
      return rows;
    },
    get state() {
      return state;
    },
    source: (destination: number) => sourceAt(state, destination, VIDEO),
    /** Routes as the page's Take does: the request carries what this copy last saw on that output. */
    route: (source: number, destination: number) =>
      api.routeCrosspoints({
        operationId: randomUUID() as never,
        connectionId: router.connectionId as never,
        version: state.version,
        mappings: [
          {
            mappingId: randomUUID() as never,
            source,
            destination,
            levels: [VIDEO],
            expected: [
              { level: VIDEO, source: sourceAt(state, destination, VIDEO) },
            ],
          },
        ],
      }),
    interrogate: (destination: number) =>
      api.interrogateRouterTargets({
        requestId: randomUUID() as never,
        connectionId: router.connectionId as never,
        generation: state.version.generation,
        targets: [{ destination, levels: [VIDEO] }],
      }),
    close() {
      api.disconnectRouterState();
      stopFollowing();
      router.pages.delete(deliver);
    },
    windowClosed() {
      lifetime.abort(new Error("Module page closed or changed"));
      stopFollowing();
      router.pages.delete(deliver);
    },
  };
  cleanups.push(() => copy.close());
  return copy;
}

it("declares the Router page and its Button Matrix settings for several windows", () => {
  const manifest = withRouterInterface("blackmagic-videohub", {
    host: { minimumVersion: "2.0.18", requiredFeatures: [] },
    capabilities: [],
    actions: [],
    feedback: [],
  } as never);
  const sections = (manifest.pages ?? []).flatMap((page) => page.sections);
  expect(sections.map((section) => [section.id, "windows" in section && section.windows])).toEqual([
    ["router", true],
    ["routing-settings", true],
  ]);
  expect(
    "requiredFeatures" in manifest.host ? manifest.host.requiredFeatures : [],
  ).toContain("module-page-windows-v1");
});

it("a route taken in one window shows in the other at once, and either window can route next", async () => {
  const router = await startRouter();
  const first = await openPage(router);
  const second = await openPage(router);
  // The fake starts each output on its own input, so every change is visible.
  expect([first.source(3), second.source(3)]).toEqual([3, 3]);

  await expect(first.route(6, 3)).resolves.toMatchObject({
    status: "acknowledged",
  });
  await vi.waitFor(() => {
    expect(second.source(3)).toBe(6);
  });

  // The second window was never reopened. Its own routes go through, on that output too.
  await expect(second.route(2, 5)).resolves.toMatchObject({
    status: "acknowledged",
  });
  await expect(second.route(1, 3)).resolves.toMatchObject({
    status: "acknowledged",
  });
  await vi.waitFor(() => {
    expect([first.source(5), first.source(3)]).toEqual([2, 1]);
    expect([second.source(5), second.source(3)]).toEqual([2, 1]);
  });
  expect(router.fake.routeCommands).toEqual([
    { destination: 3, source: 6 },
    { destination: 5, source: 2 },
    { destination: 3, source: 1 },
  ]);
  expect([...first.resyncs, ...second.resyncs]).toEqual([]);
});

it.each(routers)(
  "%s with Simulated on: a route taken in one window shows in the other, and the other routes next",
  async (type, createManager, schemas) => {
    const running = await startRouter({
      simulated: [type, createManager, schemas],
    });
    const first = await openPage(running);
    const second = await openPage(running);
    const other = (current: number | null, ...avoid: number[]) =>
      [3, 4, 5].find((source) => source !== current && !avoid.includes(source))!;
    const one = other(first.source(2));
    await expect(first.route(one, 2)).resolves.toMatchObject({
      status: "acknowledged",
    });
    await vi.waitFor(() => {
      expect(second.source(2)).toBe(one);
    });
    const two = other(one);
    await expect(second.route(two, 2)).resolves.toMatchObject({
      status: "acknowledged",
    });
    await vi.waitFor(() => {
      expect([first.source(2), second.source(2)]).toEqual([two, two]);
    });
    expect([...first.resyncs, ...second.resyncs]).toEqual([]);
  },
);

it("Button Matrix groups saved in one window show in the other, and each window's next edit lands", async () => {
  const router = await startRouter();
  const first = await openPage(router);
  const second = await openPage(router);
  await vi.waitFor(() => {
    expect(first.rows).toHaveLength(1);
    expect(second.rows).toHaveLength(1);
  });
  const contextId = first.rows[0]!.contextId;
  const names = (copy: PageCopy) => copy.rows[0]?.groups.map(({ name }) => name);

  first.settings.addGroup(contextId);
  await vi.waitFor(() => {
    expect(names(second)).toEqual(["Group 1"]);
  });
  const id = second.rows[0]!.groups[0]!.id;
  await second.settings.renameGroup(contextId, id, "Studio");
  await vi.waitFor(() => {
    expect(names(first)).toEqual(["Studio"]);
  });

  // Each window adds after seeing the other's group, so neither picks a name already taken.
  second.settings.addGroup(contextId);
  await vi.waitFor(() => {
    expect(names(first)).toEqual(["Studio", "Group 1"]);
  });
  first.settings.addGroup(contextId);
  await vi.waitFor(() => {
    expect(names(second)).toEqual(["Studio", "Group 1", "Group 2"]);
  });

  first.settings.setAutomaticTake(contextId, false);
  second.settings.deleteGroup(contextId, id);
  await vi.waitFor(() => {
    for (const copy of [first, second]) {
      expect(names(copy)).toEqual(["Group 1", "Group 2"]);
      expect(copy.rows[0]!.automaticTake).toBe(false);
    }
  });
  expect([...first.failures, ...second.failures]).toEqual([]);
});

it("page preferences saved from two windows at once are all kept", async () => {
  const router = await startRouter();
  const first = await openPage(router);
  const second = await openPage(router);
  await Promise.all([
    first.bridge.call("set-zoom", 125),
    second.bridge.call("set-view", "routes"),
    first.bridge.call("set-automatic-take", true),
  ]);
  expect(routerViewPreferences(router.store.value("router-view"))).toEqual({
    zoom: 125,
    automaticTake: true,
    view: "routes",
  });
});

it("routes and refreshes from two windows at the same moment all go through", async () => {
  // The fake holds each route's acknowledgement, so all four commands are in flight together.
  const router = await startRouter({ routeAcknowledgementDelayMs: 100 });
  const first = await openPage(router);
  const second = await openPage(router);
  const results = await Promise.all([
    first.route(7, 1),
    second.route(8, 2),
    first.interrogate(4),
    second.interrogate(6),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "acknowledged",
    "acknowledged",
    expect.any(String),
    expect.any(String),
  ]);
  expect(results.slice(2).map((result) => result.status)).not.toContain("rejected");
  await vi.waitFor(() => {
    for (const copy of [first, second])
      expect([copy.source(1), copy.source(2)]).toEqual([7, 8]);
  });
});

it("eight windows can show the Router page at once, as many pages as Hubble opens for one module", async () => {
  const router = await startRouter();
  const copies: PageCopy[] = [];
  for (let index = 0; index < 8; index++) copies.push(await openPage(router));
  await expect(openPage(router)).rejects.toThrow(
    "Close an unused router page before opening another",
  );
  await expect(copies[0]!.route(5, 8)).resolves.toMatchObject({
    status: "acknowledged",
  });
  await vi.waitFor(() => {
    expect(copies.map((copy) => copy.source(8))).toEqual(Array(8).fill(5));
  });

  // A page that closes itself gives its place back.
  copies[7]!.close();
  await vi.waitFor(async () => {
    await expect(openPage(router)).resolves.toBeDefined();
  });
});

it("a window that HubDash closes gives its Router page back at once", async () => {
  const router = await startRouter();
  const copies: PageCopy[] = [];
  for (let index = 0; index < 8; index++) copies.push(await openPage(router));
  // HubDash ends the page's waiting request when its window closes; the page itself says nothing.
  copies[3]!.windowClosed();
  await vi.waitFor(async () => {
    await expect(openPage(router)).resolves.toBeDefined();
  }, { timeout: 2000 });
  // The windows still open follow on as before.
  await expect(copies[0]!.route(4, 6)).resolves.toMatchObject({
    status: "acknowledged",
  });
  await vi.waitFor(() => {
    expect(copies.filter((_, index) => index !== 3).map((copy) => copy.source(6))).toEqual(
      Array(7).fill(4),
    );
  });
});
