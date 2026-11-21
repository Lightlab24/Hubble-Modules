import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  OgpCrosspoint,
  UltrixOgpClientEvent,
  UltrixOgpSnapshot,
} from '@hubble/protocol-ultrix-ogp'
import type { RouterActionDefinition } from '@hubble/router-runtime/actions'
import { RouterGroupController } from '@hubble/router-runtime/group-controller'
import {
  normalizeRouterGroups,
  RouterGroupDocumentSchema,
} from '@hubble/router-runtime/group-document'
import { createRouterMatrixFeedback, routerMatrixAction } from '@hubble/router-runtime/matrix'
import type {
  ModuleContext,
  ModuleDocumentRequest,
  ModuleDocumentSnapshot,
  ModuleHostServices,
  ModuleLogicalContext,
} from '@hubble/module-sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { RossUltrixOgpConnectionDefinitionSchema } from '../src/config.js'
import {
  RossUltrixOgpConnectionManager,
  type RossUltrixOgpManagedClient,
} from '../src/ross-ultrix-ogp-connection-manager.js'

/** The Base Ultrix: 17 levels, level 1 video and 16 audio. */
const LEVELS = 17
const ALL_LEVELS = Array.from({ length: LEVELS }, (_, index) => index + 1)

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * Reports what a connected UltrixOgpClient reports: a take of its own and a route
 * another controller made both arrive as `route`/`routes` events once the router
 * has them, the second one with nothing sent from Hubble.
 */
class UltrixStandIn implements RossUltrixOgpManagedClient {
  readonly listeners = new Set<(event: UltrixOgpClientEvent) => void>()
  readonly writes: { source: number; destination: number; levels: readonly number[] }[] = []
  readonly #routes = new Map<string, number>()
  #value: UltrixOgpSnapshot

  constructor() {
    for (let destination = 1; destination <= 4; destination += 1)
      for (const level of ALL_LEVELS) this.#routes.set(`${destination}:${level}`, 46)
    this.#value = {
      phase: 'disconnected',
      revision: 0,
      catalogRevision: 1,
      controlReady: true,
      takeError: null,
      sources: labels('CAM', 64),
      destinations: labels('MON', 4),
      levels: Object.freeze(
        ALL_LEVELS.map((level) => ({
          level,
          label: level === 1 ? 'Video' : `Audio ${String(level - 1)}`,
        })),
      ),
      routes: this.#sortedRoutes(),
      subscriptions: Object.freeze([
        'params.statusByDestination',
        'params.controlready',
        'params.takeError',
      ]),
      multiSetEnabled: true,
      lastError: null,
    }
  }

  connect(): Promise<void> {
    if (this.#value.phase !== 'connected') {
      this.#value = { ...this.#value, phase: 'connected' }
      this.#emit({ type: 'phase', phase: 'connected', error: null })
    }
    return Promise.resolve()
  }

  disconnect(): void {
    if (this.#value.phase === 'disconnected') return
    this.#value = { ...this.#value, phase: 'disconnected' }
    this.#emit({ type: 'phase', phase: 'disconnected', error: null })
  }

  refreshNames(): Promise<void> {
    return Promise.resolve()
  }

  refreshRoutes(): Promise<void> {
    return Promise.resolve()
  }

  readDestination(
    destination: number,
    levels: readonly number[] = ALL_LEVELS,
  ): Promise<readonly OgpCrosspoint[]> {
    return Promise.resolve(
      Object.freeze(
        levels.map((level) => ({
          destination,
          level,
          source: this.#routes.get(`${destination}:${level}`) ?? null,
        })),
      ),
    )
  }

  setCrosspoint(input: {
    readonly source: number
    readonly destination: number
    readonly levels?: readonly number[]
  }): Promise<void> {
    const levels = input.levels ?? ALL_LEVELS
    this.writes.push({ source: input.source, destination: input.destination, levels })
    this.#apply(input.source, input.destination, levels)
    return Promise.resolve()
  }

  /** Another panel, DashBoard or TSL Tally's routing changes a route on the router. */
  routeFromElsewhere(source: number, destination: number, levels: readonly number[]): void {
    this.#apply(source, destination, levels)
  }

  snapshot(): UltrixOgpSnapshot {
    return this.#value
  }

  subscribe(listener: (event: UltrixOgpClientEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  #apply(source: number, destination: number, levels: readonly number[]): void {
    const changed = levels
      .filter((level) => this.#routes.get(`${destination}:${level}`) !== source)
      .map((level) => Object.freeze({ destination, level, source }))
    if (changed.length === 0) return
    for (const crosspoint of changed)
      this.#routes.set(`${destination}:${crosspoint.level}`, source)
    const previousRevision = this.#value.revision
    this.#value = {
      ...this.#value,
      revision: previousRevision + 1,
      routes: this.#sortedRoutes(),
    }
    this.#emit(
      changed.length === 1
        ? {
            type: 'route',
            crosspoint: changed[0]!,
            previousRevision,
            revision: this.#value.revision,
          }
        : {
            type: 'routes',
            crosspoints: Object.freeze(changed),
            previousRevision,
            revision: this.#value.revision,
          },
    )
  }

  #sortedRoutes(): readonly OgpCrosspoint[] {
    return Object.freeze(
      [...this.#routes].map(([key, source]) => {
        const [destination, level] = key.split(':').map(Number)
        return Object.freeze({ destination: destination!, level: level!, source })
      }),
    )
  }

  #emit(event: UltrixOgpClientEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function labels(prefix: string, count: number) {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => ({
      address: index + 1,
      label: `${prefix} ${String(index + 1)}`,
      description: null,
    })),
  )
}

/** One operator with one routing group on Automatic Take, as on Base. */
async function rossGroup() {
  const runtimeDirectory = await mkdtemp(path.join(tmpdir(), 'ross-outside-route-'))
  cleanups.push(() => rm(runtimeDirectory, { recursive: true, force: true }))
  const scope = {
    kind: 'connection' as const,
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
  }
  const operator: ModuleLogicalContext = {
    name: 'Operator',
    reference: {
      kind: 'hubble-context-reference',
      formatVersion: 1,
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      contextId: randomUUID(),
      unresolved: false,
    },
  }
  const groupId = randomUUID()
  const document: ModuleDocumentSnapshot = {
    workspaceId: scope.workspaceId,
    owner: {
      kind: 'connection',
      connectionId: scope.connectionId,
      moduleId: 'hubble-ross-ultrix-ogp',
    },
    id: 'routing-groups',
    version: 1,
    revision: null,
    value: {
      contexts: [
        {
          reference: operator.reference,
          automaticTake: true,
          groups: [{ id: groupId, name: 'Group 1' }],
          groupAliases: {},
        },
      ],
    },
    canUndo: false,
    canRedo: false,
  }
  const services = {
    request: async (service: string, _version: number, raw: unknown, signal?: AbortSignal) => {
      const input = raw as ModuleDocumentRequest
      if (input.method === 'watch')
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Cancelled')), {
            once: true,
          })
        })
      if (service === 'contexts')
        return { revision: 'a'.repeat(64), contexts: structuredClone([operator]) }
      if (input.method === 'write') {
        document.value = normalizeRouterGroups(
          RouterGroupDocumentSchema.parse(document.value),
          input.value,
        )
        document.revision = randomUUID()
      }
      return { status: 'document', document: structuredClone(document) }
    },
  } as unknown as ModuleHostServices

  const ultrix = new UltrixStandIn()
  const manager = new RossUltrixOgpConnectionManager(() => ultrix)
  cleanups.push(() => manager.stop())
  manager.reconcile([
    RossUltrixOgpConnectionDefinitionSchema.parse({
      connectionId: scope.connectionId,
      type: 'ross-ultrix-ogp',
      name: 'Ultrix',
      enabled: true,
      host: '10.20.50.50',
      port: 5254,
      sourceLimit: 64,
      destinationLimit: 4,
      levels: LEVELS,
      requestTimeoutMs: 1000,
      reconnectDelayMs: 2000,
      schemaVersion: 1,
    }),
  ])
  await vi.waitFor(() => {
    expect(manager.routeState(scope.connectionId).phase).toBe('ready')
  })

  const context: ModuleContext = {
    runtimeDirectory,
    scope,
    instanceId: randomUUID(),
    settings: {},
    services,
    log: vi.fn(),
    publishFeedback: vi.fn(),
    publishState: vi.fn(),
  }
  const controller = new RouterGroupController(context, manager)
  cleanups.push(() => controller.stop())
  await controller.refresh()

  const press = {
    ...scope,
    moduleConnectionId: operator.reference.contextId,
    groupId,
  }
  /** A Select SRC button as the Button Matrix saves it: Levels left empty means every level. */
  const selectSourceButton = (source: number): RouterActionDefinition => {
    const mapped = routerMatrixAction(
      'ross-ultrix-ogp',
      {
        contextId: operator.reference.contextId,
        actionId: randomUUID(),
        actionColumnId: randomUUID(),
        values: {
          enabled: true,
          actionType: 'select-source',
          actionGroup: groupId,
          actionValue: source,
          levels: '',
          drivesTally: true,
          feedbackColor: '#09ECFF',
        },
      },
      { levels: LEVELS },
    )
    return {
      ...mapped.fields,
      type: mapped.id,
      connectionId: scope.connectionId,
      enabled: true,
    } as RouterActionDefinition
  }
  /** Which Select SRC buttons light, as Hubble would draw them now. */
  const lit = (sources: readonly number[]) => {
    const feedback = createRouterMatrixFeedback(scope.workspaceId, controller, manager.snapshots())
    return sources.filter((source) => feedback(selectSourceButton(source)).state === 'active')
  }
  return { controller, manager, press, scope, ultrix, lit }
}

/**
 * The operator's Select DST. With Automatic Take on and nothing chosen yet it says the source
 * is missing, keeps the destination and shows what the router has there.
 */
async function chooseDestination(group: Awaited<ReturnType<typeof rossGroup>>, destination: number) {
  await group.controller
    .dispatch('selectDestination', { ...group.press, destination })
    .catch((error: unknown) => {
      expect(String(error)).toContain('selected source is not configured')
    })
  await vi.waitFor(() => expect(group.lit([46])).toEqual([46]))
}

it('lights the Select SRC button of a source the operator took on every level', async () => {
  const group = await rossGroup()
  await chooseDestination(group, 1)
  await group.controller.dispatch('selectSource', { ...group.press, source: 3, levels: [] })
  await vi.waitFor(() => expect(group.lit([1, 2, 3, 46])).toEqual([3]))
  expect(group.ultrix.writes).toEqual([{ source: 3, destination: 1, levels: ALL_LEVELS }])
})

it('follows a route made elsewhere on every level, with nothing sent to the router', async () => {
  const group = await rossGroup()
  await chooseDestination(group, 1)
  await group.controller.dispatch('selectSource', { ...group.press, source: 3, levels: [] })
  await vi.waitFor(() => expect(group.lit([2, 3])).toEqual([3]))

  group.ultrix.routeFromElsewhere(2, 1, ALL_LEVELS)
  await vi.waitFor(() => expect(group.lit([2, 3])).toEqual([2]))
  expect(group.ultrix.writes).toHaveLength(1)
})

/**
 * Kept on purpose (user's choice, Nov 21 2026): a Select SRC button with Levels left empty
 * stands for every level, so it lights only while its source is on all of them. TSL Tally's
 * routing sends one level, so its route splits the destination and no button lights until
 * every level agrees again.
 */
it('lights no Select SRC button while a route made elsewhere on video only splits the destination', async () => {
  const group = await rossGroup()
  await chooseDestination(group, 1)
  await group.controller.dispatch('selectSource', { ...group.press, source: 3, levels: [] })
  await vi.waitFor(() => expect(group.lit([2, 3])).toEqual([3]))

  // TSL Tally's routing: source 2 to destination 1, level 1 only.
  group.ultrix.routeFromElsewhere(2, 1, [1])
  expect(group.lit([2, 3, 46])).toEqual([])
  await new Promise((resolve) => setImmediate(resolve))
  expect(group.lit([2, 3, 46])).toEqual([])

  // Video back on 3: every level agrees with the operator's take again.
  group.ultrix.routeFromElsewhere(3, 1, [1])
  await vi.waitFor(() => expect(group.lit([2, 3])).toEqual([3]))

  // Video on 2 again, then the rest of the levels follow: 2 lights.
  group.ultrix.routeFromElsewhere(2, 1, [1])
  expect(group.lit([2, 3])).toEqual([])
  group.ultrix.routeFromElsewhere(2, 1, ALL_LEVELS.slice(1))
  await vi.waitFor(() => expect(group.lit([2, 3])).toEqual([2]))
  expect(group.ultrix.writes).toHaveLength(1)
})
