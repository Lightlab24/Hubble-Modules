import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const MAX_PERSISTED_GROUP_STATES = 16_384;
const MAX_RECENT_TRANSITION_IDS = 256;

const UuidSchema = z.string().uuid();
const RouterAddressSchema = z.int().min(1).max(65_536);
const RouterLevelSchema = z.int().min(1).max(256);

const PersistedRossRouteGroupStateSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    moduleConnectionId: UuidSchema,
    connectionId: UuidSchema,
    groupId: UuidSchema.nullable(),
    enabled: z.boolean().default(true),
    selectedDestination: RouterAddressSchema.nullable(),
    /** Empty until the group has a successful routed level set to restore. */
    levels: z.array(RouterLevelSchema).max(256).readonly(),
    committedTakeSequence: z.int().nonnegative().nullable(),
  })
  .readonly();

const PersistedRossRouteModuleSequenceStateSchema = z
  .strictObject({
    workspaceId: UuidSchema,
    moduleConnectionId: UuidSchema,
    /** Includes failed/pending submissions so sequence values are never reused after restart. */
    moduleSequenceHighWaterMark: z.int().nonnegative(),
  })
  .readonly();

const PersistedTransitionStreamSchema = z
  .strictObject({
    streamId: UuidSchema,
    lastAppliedSequence: z.int().positive(),
    recentlyAppliedTransitionIds: z
      .array(UuidSchema)
      .max(MAX_RECENT_TRANSITION_IDS)
      .readonly(),
  })
  .readonly();

const RossRouteGroupStateDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    groups: z
      .array(PersistedRossRouteGroupStateSchema)
      .max(MAX_PERSISTED_GROUP_STATES)
      .readonly(),
    modules: z
      .array(PersistedRossRouteModuleSequenceStateSchema)
      .max(MAX_PERSISTED_GROUP_STATES)
      .readonly(),
    streams: z.array(PersistedTransitionStreamSchema).max(16).readonly(),
  })
  .readonly();

export type PersistedRossRouteGroupState = z.infer<
  typeof PersistedRossRouteGroupStateSchema
>;
type PersistedRossRouteGroupStateInput = z.input<
  typeof PersistedRossRouteGroupStateSchema
>;
export type PersistedRossRouteModuleSequenceState = z.infer<
  typeof PersistedRossRouteModuleSequenceStateSchema
>;

export type RossRouteGroupStateTransition =
  | Readonly<{
      streamId: string;
      sequence: number;
      transitionId: string;
      operation: "move";
      workspaceId: string;
      moduleConnectionId: string;
      fromGroupId: string | null;
      toGroupId: string | null;
    }>
  | Readonly<{
      streamId: string;
      sequence: number;
      transitionId: string;
      operation: "discard-group";
      workspaceId: string;
      moduleConnectionId: string;
      groupId: string;
    }>
  | Readonly<{
      streamId: string;
      sequence: number;
      transitionId: string;
      operation: "discard-module";
      workspaceId: string;
      moduleConnectionId: string;
    }>
  | Readonly<{
      streamId: string;
      sequence: number;
      transitionId: string;
      operation: "discard-workspace";
      workspaceId: string;
    }>;

export interface RossRouteGroupScope {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
  readonly groupIds: readonly string[];
}

export interface RossRouteGroupStateStoreDiagnostic {
  readonly code:
    | "ross_route_group_state_invalid"
    | "ross_route_group_state_write_failed";
  readonly message: string;
}

export interface JsonRossRouteGroupStateStoreOptions {
  readonly filePath: string;
  readonly onDiagnostic?: (
    diagnostic: RossRouteGroupStateStoreDiagnostic,
  ) => void;
}

interface MutableTransitionStream {
  streamId: string;
  lastAppliedSequence: number;
  recentlyAppliedTransitionIds: string[];
}

interface MutableStateDocument {
  groups: Map<string, PersistedRossRouteGroupState>;
  modules: Map<string, PersistedRossRouteModuleSequenceState>;
  streams: Map<string, MutableTransitionStream>;
}

export class JsonRossRouteGroupStateStore {
  readonly #filePath: string;
  readonly #onDiagnostic:
    | ((diagnostic: RossRouteGroupStateStoreDiagnostic) => void)
    | undefined;
  #document: MutableStateDocument = emptyDocument();
  #initializePromise: Promise<void> | null = null;
  #operationTail: Promise<void> = Promise.resolve();
  #temporaryCounter = 0;
  #closed = false;

  constructor(options: JsonRossRouteGroupStateStoreOptions) {
    if (!path.isAbsolute(options.filePath)) {
      throw new TypeError("Ross route group state path must be absolute");
    }
    this.#filePath = path.normalize(options.filePath);
    this.#onDiagnostic = options.onDiagnostic;
  }

  snapshot(): Promise<readonly PersistedRossRouteGroupState[]> {
    return this.#enqueue(async () => this.#snapshot());
  }

  moduleSnapshot(): Promise<readonly PersistedRossRouteModuleSequenceState[]> {
    return this.#enqueue(async () => this.#moduleSnapshot());
  }

  upsert(state: PersistedRossRouteGroupStateInput): Promise<void> {
    return this.#enqueue(async () => {
      const parsed = normalizeGroupState(state);
      this.#document.groups.set(groupStateKey(parsed), parsed);
      await this.#persist();
    });
  }

  upsertModuleSequenceState(
    state: PersistedRossRouteModuleSequenceState,
  ): Promise<void> {
    const parsed = PersistedRossRouteModuleSequenceStateSchema.parse(state);
    return this.#enqueue(async () => {
      const key = moduleStateKey(parsed);
      const current = this.#document.modules.get(key);
      if (
        current !== undefined &&
        parsed.moduleSequenceHighWaterMark < current.moduleSequenceHighWaterMark
      ) {
        throw new RangeError(
          "Ross route module sequence high-water mark cannot move backward",
        );
      }
      if (
        current?.moduleSequenceHighWaterMark ===
        parsed.moduleSequenceHighWaterMark
      )
        return;
      this.#document.modules.set(key, parsed);
      await this.#persist();
    });
  }

  clearWorkspace(workspaceId: string): Promise<void> {
    const parsedWorkspaceId = UuidSchema.parse(workspaceId);
    return this.#enqueue(async () => {
      const changedGroups = deleteMatching(
        this.#document.groups,
        (state) => state.workspaceId === parsedWorkspaceId,
      );
      const changedModules = deleteMatching(
        this.#document.modules,
        (state) => state.workspaceId === parsedWorkspaceId,
      );
      if (!changedGroups && !changedModules) return;
      await this.#persist();
    });
  }

  reconcileScopes(
    scopes: readonly RossRouteGroupScope[],
    workspaceIds?: readonly string[],
  ): Promise<void> {
    const validKeys = new Set<string>();
    const validModuleKeys = new Set<string>();
    const reconciledWorkspaceIds = new Set<string>();
    for (const scope of scopes) {
      const workspaceId = UuidSchema.parse(scope.workspaceId);
      const moduleConnectionId = UuidSchema.parse(scope.moduleConnectionId);
      reconciledWorkspaceIds.add(workspaceId);
      validModuleKeys.add(moduleStateKeyParts(workspaceId, moduleConnectionId));
      const groupIds = scope.groupIds.map((groupId) =>
        UuidSchema.parse(groupId),
      );
      if (groupIds.length === 0) {
        validKeys.add(
          groupStateKeyParts(workspaceId, moduleConnectionId, null),
        );
      } else {
        for (const groupId of groupIds) {
          validKeys.add(
            groupStateKeyParts(workspaceId, moduleConnectionId, groupId),
          );
        }
      }
    }
    for (const workspaceId of workspaceIds ?? []) {
      reconciledWorkspaceIds.add(UuidSchema.parse(workspaceId));
    }
    return this.#enqueue(async () => {
      const reconcileAllWorkspaces =
        workspaceIds === undefined && reconciledWorkspaceIds.size === 0;
      const changedGroups = deleteMatching(
        this.#document.groups,
        (state) =>
          (reconcileAllWorkspaces ||
            reconciledWorkspaceIds.has(state.workspaceId)) &&
          !validKeys.has(groupStateKey(state)),
      );
      const changedModules = deleteMatching(
        this.#document.modules,
        (state) =>
          (reconcileAllWorkspaces ||
            reconciledWorkspaceIds.has(state.workspaceId)) &&
          !validModuleKeys.has(moduleStateKey(state)),
      );
      if (!changedGroups && !changedModules) return;
      await this.#persist();
    });
  }

  applyTransition(
    transition: RossRouteGroupStateTransition,
  ): Promise<"applied" | "already-applied"> {
    return this.#enqueue(async () => {
      const parsed = parseTransition(transition);
      const current = this.#document.streams.get(parsed.streamId);
      if (
        current !== undefined &&
        parsed.sequence <= current.lastAppliedSequence
      ) {
        if (
          parsed.sequence === current.lastAppliedSequence &&
          !current.recentlyAppliedTransitionIds.includes(parsed.transitionId)
        ) {
          throw new RangeError(
            `transition sequence ${String(parsed.sequence)} was already applied with another id`,
          );
        }
        return "already-applied";
      }
      if (
        current !== undefined &&
        parsed.sequence !== current.lastAppliedSequence + 1
      ) {
        throw new RangeError(
          `expected transition sequence ${String(current.lastAppliedSequence + 1)}, received ${String(parsed.sequence)}`,
        );
      }

      applyTransitionToDocument(this.#document, parsed);
      const recentlyAppliedTransitionIds = [
        ...(current?.recentlyAppliedTransitionIds ?? []),
        parsed.transitionId,
      ].slice(-MAX_RECENT_TRANSITION_IDS);
      this.#document.streams.set(parsed.streamId, {
        streamId: parsed.streamId,
        lastAppliedSequence: parsed.sequence,
        recentlyAppliedTransitionIds,
      });
      await this.#persist();
      return "applied";
    });
  }

  async flush(): Promise<void> {
    await this.#operationTail;
    await this.#ensureInitialized();
  }

  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed)
      return Promise.reject(
        new Error("Ross route group state store is closed"),
      );
    const result = this.#operationTail.then(async () => {
      await this.#ensureInitialized();
      return operation();
    });
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #ensureInitialized(): Promise<void> {
    this.#initializePromise ??= this.#initialize();
    return this.#initializePromise;
  }

  async #initialize(): Promise<void> {
    let source: string;
    try {
      source = await readFile(this.#filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }

    try {
      const parsed = RossRouteGroupStateDocumentSchema.parse(
        JSON.parse(source),
      );
      this.#document = {
        groups: new Map(
          parsed.groups.map((state) => {
            const normalized = normalizeGroupState(state);
            return [groupStateKey(normalized), normalized];
          }),
        ),
        modules: new Map(
          parsed.modules.map((state) => [moduleStateKey(state), state]),
        ),
        streams: new Map(
          parsed.streams.map((stream) => [
            stream.streamId,
            {
              streamId: stream.streamId,
              lastAppliedSequence: stream.lastAppliedSequence,
              recentlyAppliedTransitionIds: [
                ...stream.recentlyAppliedTransitionIds,
              ],
            },
          ]),
        ),
      };
    } catch (error: unknown) {
      this.#document = emptyDocument();
      this.#onDiagnostic?.({
        code: "ross_route_group_state_invalid",
        message:
          error instanceof Error
            ? error.message
            : "Ross route group state is invalid",
      });
    }
    await chmod(this.#filePath, 0o600);
  }

  #snapshot(): readonly PersistedRossRouteGroupState[] {
    return Object.freeze(
      [...this.#document.groups.values()]
        .sort((left, right) =>
          groupStateKey(left).localeCompare(groupStateKey(right)),
        )
        .map((state) =>
          Object.freeze({ ...state, levels: Object.freeze([...state.levels]) }),
        ),
    );
  }

  #moduleSnapshot(): readonly PersistedRossRouteModuleSequenceState[] {
    return Object.freeze(
      [...this.#document.modules.values()]
        .sort((left, right) =>
          moduleStateKey(left).localeCompare(moduleStateKey(right)),
        )
        .map((state) => Object.freeze({ ...state })),
    );
  }

  async #persist(): Promise<void> {
    const directory = path.dirname(this.#filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.tmp-${String(process.pid)}-${String(++this.#temporaryCounter)}`;
    const document = RossRouteGroupStateDocumentSchema.parse({
      schemaVersion: 1,
      groups: this.#snapshot(),
      modules: this.#moduleSnapshot(),
      streams: [...this.#document.streams.values()]
        .sort((left, right) => left.streamId.localeCompare(right.streamId))
        .map((stream) => ({
          ...stream,
          recentlyAppliedTransitionIds: [
            ...stream.recentlyAppliedTransitionIds,
          ],
        })),
    });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch (error: unknown) {
      await unlink(temporaryPath).catch(() => undefined);
      this.#onDiagnostic?.({
        code: "ross_route_group_state_write_failed",
        message:
          error instanceof Error
            ? error.message
            : "Ross route group state write failed",
      });
      throw error;
    }
  }
}

function normalizeGroupState(
  state: PersistedRossRouteGroupStateInput,
): PersistedRossRouteGroupState {
  const parsed = PersistedRossRouteGroupStateSchema.parse(state);
  return PersistedRossRouteGroupStateSchema.parse({
    ...parsed,
    levels: [...new Set(parsed.levels)].sort((left, right) => left - right),
  });
}

function groupStateKey(state: PersistedRossRouteGroupState): string {
  return groupStateKeyParts(
    state.workspaceId,
    state.moduleConnectionId,
    state.groupId,
  );
}

function groupStateKeyParts(
  workspaceId: string,
  moduleConnectionId: string,
  groupId: string | null,
): string {
  return `${workspaceId}:${moduleConnectionId}:${groupId ?? "generic"}`;
}

function moduleStateKey(state: {
  readonly workspaceId: string;
  readonly moduleConnectionId: string;
}): string {
  return moduleStateKeyParts(state.workspaceId, state.moduleConnectionId);
}

function moduleStateKeyParts(
  workspaceId: string,
  moduleConnectionId: string,
): string {
  return `${workspaceId}:${moduleConnectionId}`;
}

const transitionBase = {
  streamId: UuidSchema,
  transitionId: UuidSchema,
  workspaceId: UuidSchema,
  sequence: z.int().positive(),
};
export const GroupStateTransitionSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...transitionBase,
    operation: z.literal("move"),
    moduleConnectionId: UuidSchema,
    fromGroupId: UuidSchema.nullable(),
    toGroupId: UuidSchema.nullable(),
  }),
  z.strictObject({
    ...transitionBase,
    operation: z.literal("discard-group"),
    moduleConnectionId: UuidSchema,
    groupId: UuidSchema,
  }),
  z.strictObject({
    ...transitionBase,
    operation: z.literal("discard-module"),
    moduleConnectionId: UuidSchema,
  }),
  z.strictObject({
    ...transitionBase,
    operation: z.literal("discard-workspace"),
  }),
]);

function parseTransition(input: unknown): RossRouteGroupStateTransition {
  const transition = GroupStateTransitionSchema.parse(input);
  UuidSchema.parse(transition.streamId);
  UuidSchema.parse(transition.transitionId);
  UuidSchema.parse(transition.workspaceId);
  if (!Number.isSafeInteger(transition.sequence) || transition.sequence < 1) {
    throw new RangeError(
      "Ross route group state transition sequence must be positive",
    );
  }
  if ("moduleConnectionId" in transition)
    UuidSchema.parse(transition.moduleConnectionId);
  if (transition.operation === "move") {
    if (transition.fromGroupId !== null)
      UuidSchema.parse(transition.fromGroupId);
    if (transition.toGroupId !== null) UuidSchema.parse(transition.toGroupId);
    if (transition.fromGroupId === transition.toGroupId) {
      throw new RangeError(
        "Ross route group state move must change group identity",
      );
    }
  }
  if (transition.operation === "discard-group")
    UuidSchema.parse(transition.groupId);
  return Object.freeze({ ...transition });
}

function applyTransitionToDocument(
  document: MutableStateDocument,
  transition: RossRouteGroupStateTransition,
): void {
  const groups = document.groups;
  switch (transition.operation) {
    case "move": {
      const sourceKey = groupStateKeyParts(
        transition.workspaceId,
        transition.moduleConnectionId,
        transition.fromGroupId,
      );
      const source = groups.get(sourceKey);
      if (source === undefined) return;
      groups.delete(sourceKey);
      const moved = normalizeGroupState({
        ...source,
        groupId: transition.toGroupId,
        enabled: transition.toGroupId === null ? true : source.enabled,
      });
      groups.set(groupStateKey(moved), moved);
      return;
    }
    case "discard-group":
      groups.delete(
        groupStateKeyParts(
          transition.workspaceId,
          transition.moduleConnectionId,
          transition.groupId,
        ),
      );
      return;
    case "discard-module":
      deleteMatching(
        groups,
        (state) =>
          state.workspaceId === transition.workspaceId &&
          state.moduleConnectionId === transition.moduleConnectionId,
      );
      document.modules.delete(
        moduleStateKeyParts(
          transition.workspaceId,
          transition.moduleConnectionId,
        ),
      );
      return;
    case "discard-workspace":
      deleteMatching(
        groups,
        (state) => state.workspaceId === transition.workspaceId,
      );
      deleteMatching(
        document.modules,
        (state) => state.workspaceId === transition.workspaceId,
      );
  }
}

function deleteMatching<TState>(
  entries: Map<string, TState>,
  predicate: (state: TState) => boolean,
): boolean {
  let changed = false;
  for (const [key, state] of entries) {
    if (!predicate(state)) continue;
    entries.delete(key);
    changed = true;
  }
  return changed;
}

function emptyDocument(): MutableStateDocument {
  return { groups: new Map(), modules: new Map(), streams: new Map() };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
