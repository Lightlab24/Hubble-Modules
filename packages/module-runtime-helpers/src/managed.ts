import {
  ActionAbortedError,
  type AdapterActionResult,
} from '@hubble/module-contracts/execution'
import { createModuleDataPublisher } from '@hubble/module-contracts/observations'
import type {
  HubbleModule,
  ModuleContext,
  ModuleExecutionContext,
  ModuleJsonValue,
} from '@hubble/module-sdk'
import type { z } from 'zod'
import { legacyExecution } from './legacy.js'

export interface ModuleConnection {
  readonly connectionId: string
  readonly type: string
  readonly name: string
}
export interface ModuleSchemas<TDefinition, TAction> {
  readonly connection: z.ZodType<TDefinition>
  readonly actions: Readonly<Record<string, z.ZodType<TAction>>>
}

interface ManagedDriver<TAction> {
  start(): void | Promise<void>
  stop(): void | Promise<void>
  subscribe(listener: (snapshots: readonly unknown[]) => void): () => void
  execute(action: TAction, execution: ModuleExecutionContext): Promise<AdapterActionResult>
  call?(method: string, value: ModuleJsonValue, signal: AbortSignal): unknown
}
export function managedModule<TDefinition extends ModuleConnection, TAction>(
  type: TDefinition['type'],
  create: (definition: TDefinition, context: ModuleContext) => ManagedDriver<TAction>,
  evidence: { kind: 'response' | 'state-confirmed' | 'submitted' | 'local'; summary: string },
  schemas: ModuleSchemas<TDefinition, TAction>,
): HubbleModule {
  return {
    createInstance(context) {
      if (context.scope.kind !== 'connection')
        throw new Error('Module requires a physical connection scope')
      const definition = schemas.connection.parse({
        ...context.settings,
        type,
        connectionId: context.scope.connectionId,
        enabled: true,
        schemaVersion: 1,
      })
      const driver = create(definition, context)
      let started = false
      let unsubscribe = () => {}
      let phase = ''
      let health = ''
      const publisher = createModuleDataPublisher((channel, value) => {
        if (!context.publishEvent) throw new Error('Host does not support module observations')
        context.publishEvent(channel, value)
      })
      return {
        async start() {
          started = true
          unsubscribe = driver.subscribe((snapshots) => {
            if (!started) return
            if (!context.publishEvent)
              throw new Error('Host does not support module observations')
            publisher.publish('driver.snapshots', snapshots)
            const snapshot = snapshots[0] as
              | {
                  phase?: string
                  lastError?: string | null
                  connection?: { connected: boolean; phase: string; lastError: string | null }
                }
              | undefined
            const observedPhase = snapshot?.connection?.phase ?? snapshot?.phase ?? 'connecting'
            const ready =
              snapshot?.connection?.connected ??
              (observedPhase === 'ready' ||
                observedPhase === 'connected' ||
                observedPhase === 'listening')
            const state = {
              phase: ready
                ? ('ready' as const)
                : observedPhase === 'checking' ||
                    observedPhase === 'connecting' ||
                    observedPhase === 'discovering' ||
                    observedPhase === 'handshaking'
                  ? ('connecting' as const)
                  : ('unavailable' as const),
              message: snapshot?.connection?.lastError ?? snapshot?.lastError ?? null,
            }
            const nextHealth = JSON.stringify(state)
            if (nextHealth !== health) {
              health = nextHealth
              context.publishState({
                ...state,
                observedAt: new Date().toISOString(),
                values: {},
              })
            }
            if (phase !== observedPhase) {
              phase = observedPhase
              context.log({
                level: 'info',
                stage: 'connection-state',
                message: `Observed ${definition.name} connection phase: ${phase}`,
              })
            }
          })
          await driver.start()
        },
        async execute(id, fields, execution) {
          const schema = Object.hasOwn(schemas.actions, id) ? schemas.actions[id] : undefined
          if (!schema)
            return {
              status: 'failure',
              category: 'invalid-config',
              message: 'Unknown module action',
            }
          const parsed = schema.safeParse({
            ...fields,
            type: id,
            connectionId: definition.connectionId,
            interaction: execution.gesture,
            wrap: execution.wrap,
          })
          if (!started || !parsed.success)
            return {
              status: 'failure',
              category: 'invalid-config',
              message: 'Invalid action or stopped module',
            }
          if (isCancelled(execution.signal))
            return {
              status: 'failure',
              category: 'cancelled',
              message: 'Cancelled before dispatch',
            }
          execution.log({
            level: 'debug',
            stage: 'dispatch',
            message: 'Validated action passed to the protocol adapter',
          })
          try {
            const result = await driver.execute(parsed.data, execution)
            if (isCancelled(execution.signal))
              return {
                status: 'failure',
                category: 'cancelled',
                message: 'Cancelled; dispatched work is not replayed',
              }
            if (result.outcome === 'failure') {
              execution.log({
                level: 'error',
                stage: 'command-failed',
                message: result.errorMessage,
              })
              return {
                status: 'failure',
                category: result.errorCode.includes('timeout') ? 'timeout' : 'rejected',
                code: result.errorCode,
                message: result.errorMessage,
              }
            }
            execution.log({ level: 'info', stage: 'completed', message: evidence.summary })
            return { status: 'success', evidence }
          } catch (error) {
            if (error instanceof ActionAbortedError || isCancelled(execution.signal))
              return {
                status: 'failure',
                category: 'cancelled',
                message: 'Action cancelled; dispatched work is not replayed',
              }
            return {
              status: 'failure',
              category: 'internal',
              message: 'Module action failed unexpectedly',
            }
          }
        },
        async call(method, value, execution) {
          if (!started || !driver.call) throw new Error('Module service unavailable')
          return JSON.parse(
            JSON.stringify((await driver.call(method, value, execution.signal)) ?? null),
          ) as ModuleJsonValue
        },
        async dispose() {
          started = false
          publisher.close()
          unsubscribe()
          await driver.stop()
        },
      }
    },
  }
}
export { legacyExecution }

function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted
}
