import {
  createModuleDataPublisher,
  publishModuleData,
} from '@hubble/module-contracts/observations'
import type { ModuleSchemas } from '@hubble/module-runtime-helpers/managed'
import { legacyExecution, managedModule } from '@hubble/module-runtime-helpers/managed'
import type { ModuleJsonValue } from '@hubble/module-sdk'
import { z } from 'zod'
import {
  RouterActionExecutor,
  type RossRouteGroupActionRuntimeContract,
  type RouterActionDefinition,
} from './actions.js'
import type { RouterConnectionManagerContract } from './connection-contract.js'
import {
  InterrogateRouterTargetsRequestSchema,
  RouteCrosspointsRequestSchema,
} from './requests.js'
import type { RouterConnectionDefinition } from './types.js'

const address = z.int().positive().max(65536)
const levels = z.array(z.int().positive().max(256)).max(256)
const direct = z.object({ source: address, destination: address, levels: levels.optional() })
const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue

export function routerModule(
  type: RouterConnectionDefinition['type'],
  createManager: () => RouterConnectionManagerContract,
  schemas: ModuleSchemas<RouterConnectionDefinition, RouterActionDefinition>,
) {
  return managedModule(
    type,
    (definition, context) => {
      const manager: RouterConnectionManagerContract = createManager()
      const connectionId = definition.connectionId
      const groups = Object.fromEntries(
        [
          'selectSource',
          'selectDestination',
          'cycleDestination',
          'take',
          'toggleGroupEnabled',
        ].map((method) => [
          method,
          async (input: unknown) => {
            if (!context.requestHost)
              throw new Error('Shared router coordination is unavailable')
            await context.requestHost('router-groups', json({ method, input }))
          },
        ]),
      ) as unknown as RossRouteGroupActionRuntimeContract
      const executor = new RouterActionExecutor(manager, groups, context.scope.workspaceId)
      const watches = new Map<string, () => void>()
      let unsubscribeState = () => {}
      let unsubscribePrimary = () => {}
      const emit = (channel: string, value: unknown) => {
        if (!context.publishEvent) throw new Error('Host lacks router observation support')
        publishModuleData(context.publishEvent.bind(context), channel, value)
      }
      const publisher = createModuleDataPublisher((channel, value) => {
        if (!context.publishEvent) throw new Error('Host lacks router observations')
        context.publishEvent(channel, value)
      })
      return {
        start() {
          manager.reconcile([definition])
          unsubscribeState = manager.subscribeRouteState(connectionId, (event) => {
            emit('router.state', { event, state: manager.routeState(connectionId) })
          })
          unsubscribePrimary = manager.subscribePrimaryRouteFeedback((snapshots) => {
            publisher.publish('router.primary', snapshots)
          })
        },
        stop() {
          publisher.close()
          unsubscribeState()
          unsubscribePrimary()
          for (const unsubscribe of watches.values()) unsubscribe()
          watches.clear()
          manager.stop()
        },
        subscribe: (listener) =>
          manager.subscribe((snapshots) => {
            listener(
              snapshots.map((snapshot) => ({
                ...snapshot,
                routingState: manager.routeState(snapshot.definition.connectionId),
              })),
            )
          }),
        execute: (action, execution) =>
          executor.execute(action as RouterActionDefinition, legacyExecution(execution)),
        async call(method, value, signal) {
          if (signal.aborted) throw new Error('Cancelled before router dispatch')
          switch (method) {
            case 'refreshNames':
              return manager.refreshNames(connectionId)
            case 'setDestinationLock': {
              const input = z
                .strictObject({ destination: address, locked: z.boolean() })
                .parse(value)
              if (!manager.setDestinationLock)
                throw new Error('Destination locking is unavailable')
              return manager.setDestinationLock(
                connectionId,
                input.destination,
                input.locked,
                signal,
              )
            }
            case 'recallSalvo': {
              if (!manager.recallSalvo) throw new Error('Salvos are unavailable')
              return manager.recallSalvo(connectionId, address.parse(value), signal)
            }
            case 'routeCrosspoints':
              return manager.routeCrosspoints({
                ...RouteCrosspointsRequestSchema.parse(value),
                connectionId,
              })
            case 'interrogateRouteTargets':
              return manager.interrogateRouteTargets({
                ...InterrogateRouterTargetsRequestSchema.parse(value),
                connectionId,
              })
            case 'selectDestination': {
              manager.selectDestination(connectionId, address.parse(value))
              return
            }
            case 'selectSource':
            case 'submitSelectSource': {
              const input = z
                .strictObject({ source: address, levels: levels.optional() })
                .parse(value)
              return method === 'submitSelectSource' && manager.submitSelectSource
                ? manager.submitSelectSource(connectionId, input.source, input.levels)
                : manager.selectSource(connectionId, input.source, input.levels)
            }
            case 'take':
            case 'submitTake': {
              const selected = value === null ? undefined : levels.parse(value)
              return method === 'submitTake' && manager.submitTake
                ? manager.submitTake(connectionId, selected)
                : manager.take(connectionId, selected)
            }
            case 'directRoute':
            case 'submitDirectRoute':
            case 'submitDirectRouteTracked': {
              const parsed = direct.parse(value)
              const input = {
                connectionId,
                source: parsed.source,
                destination: parsed.destination,
                ...(parsed.levels ? { levels: parsed.levels } : {}),
              }
              if (method === 'directRoute') return manager.directRoute(input)
              if (method === 'submitDirectRoute')
                return manager.submitDirectRoute?.(input) ?? manager.directRoute(input)
              const id = z.object({ id: z.uuid() }).parse(value).id
              const submission = manager.submitDirectRouteTracked(input)
              const report = (stage: 'accepted' | 'settled', error?: unknown) => {
                emit('router.submission', {
                  id,
                  stage,
                  ok: error === undefined,
                  message: error instanceof Error ? error.message.slice(0, 1000) : null,
                })
              }
              void submission.accepted.then(
                () => {
                  report('accepted')
                },
                (error: unknown) => {
                  report('accepted', error)
                },
              )
              await submission.settled.then(
                () => {
                  report('settled')
                },
                (error: unknown) => {
                  report('settled', error)
                  throw error
                },
              )
              return null
            }
            case 'watch': {
              const input = z
                .strictObject({ id: z.uuid(), destination: address, levels: levels.min(1) })
                .parse(value)
              watches.get(input.id)?.()
              if (!watches.has(input.id) && watches.size >= 1024)
                throw new Error('Confirmed-route watch capacity reached')
              watches.set(
                input.id,
                manager.watchConfirmedRouteTarget(
                  { connectionId, destination: input.destination, levels: input.levels },
                  (snapshot) => {
                    emit('router.watch', { id: input.id, snapshot })
                  },
                ),
              )
              return null
            }
            case 'unwatch': {
              const id = z.uuid().parse(value)
              watches.get(id)?.()
              watches.delete(id)
              return null
            }
            default:
              throw new Error('Unsupported router service')
          }
        },
      }
    },
    {
      kind: 'submitted',
      summary: 'Router adapter completed at its existing command submission boundary',
    },
    schemas,
  )
}
