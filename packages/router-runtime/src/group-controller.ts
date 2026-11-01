import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
  type ModuleContext,
  type ModuleLogicalContext,
  type ModuleDocumentSnapshot,
  type ModuleContextsResponse,
} from "@hubble/module-sdk";
import {
  RossRouteGroupRuntime,
  type RossRouteGroupStateTransition,
  type RossRouteGroupConnectionManager,
} from "./group-runtime.js";
import {
  JsonRossRouteGroupStateStore,
  GroupStateTransitionSchema,
} from "./group-state-store.js";
import {
  contextSettings,
  normalizeRouterGroups,
  resolveRouterGroup,
  routerContextKey,
  RouterGroupDocumentSchema,
  type RouterGroupDocument,
} from "./group-document.js";

const Scope = z.object({
  contextId: z.uuid(),
  groupIds: z.array(z.uuid()).max(64),
  automaticTake: z.boolean(),
});
const Journal = z.object({
  version: z.literal(1),
  streamId: z.uuid(),
  sequence: z.int().nonnegative(),
  applied: z.array(Scope).max(256),
  pending: z
    .object({
      scopes: z.array(Scope).max(256),
      transitions: z.array(GroupStateTransitionSchema).max(16640),
    })
    .nullable(),
});
type Journal = z.infer<typeof Journal>;

/** Package-owned settings and routing state. Only generic scoped documents/contexts are host services. */
export class RouterGroupController {
  readonly runtime: RossRouteGroupRuntime;
  readonly #client: ReturnType<typeof createModuleDocumentClient>;
  readonly #store: JsonRossRouteGroupStateStore;
  readonly #file: string;
  readonly #abort = new AbortController();
  #tail: Promise<unknown> = Promise.resolve();
  #journal: Journal | undefined;
  #contexts: ModuleLogicalContext[] = [];
  #document: ModuleDocumentSnapshot | undefined;
  #value: RouterGroupDocument = { contexts: [] };
  #watches: Promise<void>[] = [];
  readonly #failedWatches = new Set<"documents" | "contexts">();
  #stopped = false;

  constructor(
    private readonly context: ModuleContext,
    private readonly manager: RossRouteGroupConnectionManager,
    private readonly changed: () => void = () => {},
  ) {
    if (
      !context.services ||
      !context.runtimeDirectory ||
      context.scope.kind !== "connection"
    )
      throw new Error(
        "Router contexts, documents and runtime storage are required",
      );
    this.#client = createModuleDocumentClient(context.services);
    this.#file = path.join(
      context.runtimeDirectory,
      "group-configuration-journal.json",
    );
    this.#store = new JsonRossRouteGroupStateStore({
      filePath: path.join(context.runtimeDirectory, "group-state.json"),
    });
    this.runtime = new RossRouteGroupRuntime({
      connections: manager,
      stateStore: this.#store,
      onDiagnostic: (diagnostic) =>
        context.log({
          level: "error",
          stage: diagnostic.code,
          message: diagnostic.message,
        }),
    });
  }
  private ordered<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(() => {
      if (this.#stopped) throw new Error("Router groups stopped");
      return operation();
    });
    this.#tail = result.catch(() => {});
    return result;
  }
  private async persist(journal: Journal): Promise<void> {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, JSON.stringify(journal), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.#file);
      this.#journal = journal;
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  private scopes(
    contexts: ModuleLogicalContext[],
    value: RouterGroupDocument,
  ): Journal["applied"] {
    return contexts.map((context) => {
      const settings = contextSettings(value, context);
      return {
        contextId: context.reference.contextId,
        groupIds: settings.groups.map((group) => group.id),
        automaticTake: settings.automaticTake,
      };
    });
  }
  private async applyPending(): Promise<void> {
    const journal = this.#journal!;
    if (!journal.pending) return;
    for (const transition of journal.pending.transitions)
      await this.runtime.applyTransition(transition);
    await this.reconcile(journal.pending.scopes);
    await this.persist({
      ...journal,
      applied: journal.pending.scopes,
      pending: null,
    });
  }
  private async reconcile(scopes: Journal["applied"]) {
    const own = this.context.scope;
    if (own.kind !== "connection") throw new Error("Router scope changed");
    const snapshot = this.manager
      .snapshots()
      .find((item) => item.definition.connectionId === own.connectionId);
    if (!snapshot)
      throw new Error("Router connection definition is unavailable");
    const definition = snapshot.definition;
    const levelCount = "levels" in definition ? definition.levels : 1;
    await this.runtime.reconcile(
      scopes.map((item) => ({
        workspaceId: own.workspaceId,
        connectionId: own.connectionId,
        moduleConnectionId: item.contextId,
        automaticTake: item.automaticTake,
        groupIds: item.groupIds,
        levelCount,
      })),
      own.workspaceId,
    );
  }
  private async refreshNow(): Promise<void> {
    const [document, catalog] = await Promise.all([
      this.#client.read("routing-groups", this.#abort.signal),
      this.context.services!.request(
        "contexts",
        1,
        { method: "read" },
        this.#abort.signal,
      ),
    ]);
    if (document.version !== 1)
      throw new Error("Update the router module to read these groups");
    const value = RouterGroupDocumentSchema.parse(document.value);
    const scopes = this.scopes(catalog.contexts, value);
    if (!this.#journal) {
      try {
        const raw = await readFile(this.#file, "utf8");
        if (raw.length > 4_194_304)
          throw new Error("Routing configuration journal is too large");
        this.#journal = Journal.parse(JSON.parse(raw));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await this.persist({
          version: 1,
          streamId: randomUUID(),
          sequence: 0,
          applied: scopes,
          pending: null,
        });
      }
    }
    await this.applyPending();
    const journal = this.#journal!;
    if (JSON.stringify(journal.applied) !== JSON.stringify(scopes)) {
      const transitions: RossRouteGroupStateTransition[] = [];
      let sequence = journal.sequence;
      for (const before of journal.applied) {
        const after = scopes.find(
          (item) => item.contextId === before.contextId,
        );
        const base = () => ({
          streamId: journal.streamId,
          sequence: ++sequence,
          transitionId: randomUUID(),
          workspaceId: this.context.scope.workspaceId,
          moduleConnectionId: before.contextId,
        });
        if (!after)
          transitions.push({ ...base(), operation: "discard-module" });
        else if (!before.groupIds.length && after.groupIds.length)
          transitions.push({
            ...base(),
            operation: "move",
            fromGroupId: null,
            toGroupId: after.groupIds[0]!,
          });
        else if (before.groupIds.length === 1 && !after.groupIds.length)
          transitions.push({
            ...base(),
            operation: "move",
            fromGroupId: before.groupIds[0]!,
            toGroupId: null,
          });
        else
          for (const groupId of before.groupIds)
            if (!after.groupIds.includes(groupId))
              transitions.push({
                ...base(),
                operation: "discard-group",
                groupId,
              });
      }
      await this.persist({
        ...journal,
        sequence,
        pending: { scopes, transitions },
      });
      await this.applyPending();
    } else await this.reconcile(scopes);
    this.#document = document;
    this.#value = value;
    this.#contexts = catalog.contexts;
    this.changed();
  }
  refresh() {
    return this.ordered(() => this.refreshNow());
  }
  async start() {
    await this.refresh();
    const observe = async (
      name: "documents" | "contexts",
      watch: () => Promise<void>,
    ) => {
      let backoff = 250;
      while (!this.#abort.signal.aborted) {
        try {
          await watch();
          if (!this.#abort.signal.aborted) this.#failedWatches.add(name);
          backoff = 250;
        } catch (error) {
          if (this.#abort.signal.aborted) return;
          this.#failedWatches.add(name);
          this.context.log({
            level: "error",
            stage: "router-groups-watch",
            message: String(error).slice(0, 1000),
          });
        }
        await delay(backoff, undefined, { signal: this.#abort.signal }).catch(
          () => {},
        );
        backoff = Math.min(5000, backoff * 2);
      }
    };
    this.#watches = [
      observe("documents", async () => {
        for await (const _ of this.#client.watch(
          "routing-groups",
          this.#abort.signal,
        )) {
          await this.refresh();
          this.#failedWatches.delete("documents");
        }
      }),
      observe("contexts", async () => {
        let revision: string | null = null;
        while (!this.#abort.signal.aborted) {
          const next: ModuleContextsResponse =
            await this.context.services!.request(
              "contexts",
              1,
              { method: "watch", afterRevision: revision },
              this.#abort.signal,
            );
          if (next.revision !== revision) {
            revision = next.revision;
            await this.refresh();
            this.#failedWatches.delete("contexts");
          }
        }
      }),
    ];
  }
  snapshot() {
    return {
      contexts: this.#contexts.map((context) => ({
        ...context,
        settings: contextSettings(this.#value, context),
      })),
      document: this.#document,
    };
  }
  private async requireScope(contextId: string) {
    await this.refreshNow();
    return this.observedScope(contextId);
  }
  private observedScope(contextId: string) {
    const context = this.#contexts.find(
      (item) => item.reference.contextId === contextId,
    );
    if (!context) throw new Error("Routing context is unavailable");
    return context;
  }
  async edit(
    contextId: string,
    change: (
      settings: ReturnType<typeof contextSettings>,
    ) => ReturnType<typeof contextSettings>,
    signal: AbortSignal,
  ) {
    return this.ordered(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const context = await this.requireScope(contextId);
        const current = contextSettings(this.#value, context);
        const next = change(structuredClone(current));
        // The caller edits this alias only; ownership references cannot be changed by page input.
        next.reference = context.reference;
        const value = normalizeRouterGroups(this.#value, {
          ...this.#value,
          contexts: [
            ...this.#value.contexts.filter(
              (item) =>
                routerContextKey(item.reference) !==
                routerContextKey(context.reference),
            ),
            next,
          ],
        });
        try {
          await this.#client.write(this.#document!, value, signal);
          await this.refreshNow();
          return this.snapshot();
        } catch (error) {
          if (!(error instanceof ModuleDocumentConflictError) || attempt === 2)
            throw error;
        }
      }
      throw new Error("Routing settings changed; retry this edit");
    });
  }
  async dispatch(
    method:
      | "selectSource"
      | "selectDestination"
      | "cycleDestination"
      | "take"
      | "toggleGroupEnabled",
    raw: unknown,
  ) {
    const resolved = await this.ordered(async () => {
      const input = z
        .object({
          workspaceId: z.string(),
          connectionId: z.string(),
          moduleConnectionId: z.uuid(),
          groupId: z.uuid().nullable(),
        })
        .passthrough()
        .parse(raw);
      const own = this.context.scope;
      if (
        own.kind !== "connection" ||
        input.workspaceId !== own.workspaceId ||
        input.connectionId !== own.connectionId
      )
        throw new Error("Routing action scope changed");
      // start(), document/context watches and local edits reconcile this state
      // through the same ordered queue. A button press must not reread and
      // reconcile unchanged host configuration before sending its route.
      if (
        !this.#document ||
        this.#journal?.pending ||
        this.#failedWatches.size > 0 ||
        !this.#contexts.some(
          (item) => item.reference.contextId === input.moduleConnectionId,
        )
      )
        await this.refreshNow();
      const context = this.observedScope(input.moduleConnectionId);
      const groupId = resolveRouterGroup(
        contextSettings(this.#value, context),
        input.groupId,
      );
      if (method === "toggleGroupEnabled" && groupId === null)
        throw new Error("Choose a routing group to toggle");
      return { ...input, groupId };
    });
    return this.runtime[method](resolved as never);
  }
  async stop() {
    this.#stopped = true;
    this.#abort.abort();
    await Promise.allSettled(this.#watches);
    await this.#tail;
    await this.runtime.stop();
    await this.#store.close();
  }
}
