import { publishModuleData } from '@hubble/module-contracts/observations'
import type { HubbleModule, ModuleJsonValue } from '@hubble/module-sdk'
import { CccController } from './ccc-controller.js'
import {
  CccActionSchema,
  CccCommandRequestSchema,
  CccConfigSchema,
  CccMutationRequestSchema,
} from './config.js'

const json = (value: unknown): ModuleJsonValue =>
  JSON.parse(JSON.stringify(value)) as ModuleJsonValue
export function createCccModule(
  createController: (store: ConstructorParameters<typeof CccController>[0]) => CccController = (
    store,
  ) => new CccController(store),
): HubbleModule {
  return {
    createInstance(context) {
      if (context.scope.kind !== 'host' || context.scope.capabilityId !== 'ccc')
        throw new Error('CCC requires its host capability scope')
      const workspaceId = context.scope.workspaceId
      const controller = createController({
        read: async () => {
          if (!context.requestHost) throw new Error('CCC store unavailable')
          return CccConfigSchema.parse(
            await context.requestHost('ccc-store', { method: 'read' }),
          )
        },
        mutate: async (request) => {
          if (!context.requestHost) throw new Error('CCC store unavailable')
          return CccConfigSchema.parse(
            await context.requestHost('ccc-store', {
              method: 'mutate',
              request: json(request),
            }),
          )
        },
      })
      let unsubscribe = () => {}
      const emit = () => {
        if (!context.publishEvent) throw new Error('CCC observation support unavailable')
        const state = controller.state()
        publishModuleData(context.publishEvent.bind(context), 'host.ccc', state)
        const selected = new Set(
          state.config.rows.filter((row) => row.enabled).map((row) => row.rowId),
        )
        const unavailable = state.rows.find(
          (row) => selected.has(row.rowId) && row.connection !== 'online',
        )
        context.publishState({
          phase: unavailable
            ? unavailable.connection === 'connecting'
              ? 'connecting'
              : 'unavailable'
            : 'ready',
          message: unavailable?.message ?? null,
          observedAt: new Date().toISOString(),
          values: {},
        })
      }
      return {
        async start() {
          await controller.activate(workspaceId)
          unsubscribe = controller.subscribe(emit)
          emit()
        },
        async execute(id, fields, execution) {
          const action = CccActionSchema.parse({
            ...fields,
            type: id,
            interaction: execution.gesture,
            wrap: execution.wrap,
          })
          try {
            const batch = await controller.command(
              {
                workspaceId,
                command: action.command,
                ...(action.rowId ? { rowId: action.rowId } : {}),
              },
              execution.signal,
            )
            for (const result of batch.results)
              execution.log({
                level: result.phase === 'error' ? 'error' : 'info',
                stage: 'camera-result',
                message:
                  `${result.rcpIp} camera ${String(result.cameraNumber)}: ${result.message}`.slice(
                    0,
                    1000,
                  ),
              })
            const failures = batch.results.filter((result) => result.phase === 'error')
            if (failures.length)
              return {
                status: 'failure',
                category: 'rejected',
                code: 'action_exception',
                message: failures
                  .map(
                    (result) =>
                      `${result.rcpIp} camera ${String(result.cameraNumber)}: ${result.message}`,
                  )
                  .join('; ')
                  .slice(0, 256),
              }
            const confirmed =
              batch.results.length > 0 &&
              batch.results.every((result) => result.phase === 'confirmed')
            if (batch.results.length === 0)
              execution.log({
                level: 'info',
                stage: 'camera-selection',
                message: 'CCC camera selection saved locally. No command was sent to an RCP.',
              })
            return {
              status: 'success',
              evidence: {
                kind: confirmed
                  ? 'state-confirmed'
                  : batch.results.length
                    ? 'response'
                    : 'local',
                summary: confirmed
                  ? 'Every targeted camera confirmed the requested state'
                  : batch.results.length
                    ? 'RCP acknowledged delivery; see per-camera results for confirmation'
                    : 'CCC camera selection saved locally; no RCP command was sent',
              },
            }
          } catch (error) {
            return {
              status: 'failure',
              category: execution.signal.aborted ? 'cancelled' : 'rejected',
              code: 'action_exception',
              message:
                error instanceof Error ? error.message.slice(0, 1000) : 'CCC command failed',
            }
          }
        },
        async call(method, value, execution) {
          if (method === 'activate') {
            await controller.activate(workspaceId)
            return json(controller.state())
          }
          if (method === 'mutate')
            return json(
              await controller.mutate({
                ...CccMutationRequestSchema.parse(value),
                workspaceId,
              }),
            )
          if (method === 'command')
            return json(
              await controller.command(
                { ...CccCommandRequestSchema.parse(value), workspaceId },
                execution.signal,
              ),
            )
          throw new Error('Unsupported CCC service')
        },
        dispose() {
          unsubscribe()
          controller.stop()
        },
      }
    },
  }
}
export default createCccModule()
