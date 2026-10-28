import { z } from 'zod'
import type { ModuleActionResultSchema, ModuleJsonValue, ModuleValues } from './index.js'

const Id = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
/** Workspace-relative identity. Package versions can change without granting another module access. */
export const ModulePeerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('connection'), connectionId: z.uuid(), moduleId: Id }),
  z.strictObject({ kind: z.literal('host'), capabilityId: Id, moduleId: Id }),
])
export type ModulePeer = z.infer<typeof ModulePeerSchema>
export function modulePeerKey(peer: ModulePeer): string {
  return JSON.stringify([
    peer.kind,
    peer.kind === 'connection' ? peer.connectionId : peer.capabilityId,
    peer.moduleId,
  ])
}
export const ModuleDataDefinitionSchema = z.strictObject({
  id: Id,
  label: z.string().min(1).max(160),
  version: z.int().min(1).max(65535),
  query: z.boolean().default(false),
})
export const ModuleExchangeDefinitionSchema = z
  .strictObject({
    data: z.array(ModuleDataDefinitionSchema).max(64),
  })
  .superRefine((value, context) => {
    if (new Set(value.data.map((item) => item.id)).size !== value.data.length)
      context.addIssue({ code: 'custom', message: 'Duplicate shared data identity' })
  })
export const ModulePeerBindingSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(160),
  consumer: ModulePeerSchema,
  target: ModulePeerSchema,
  allowActions: z.boolean(),
  unresolved: z.boolean().optional(),
})
export const ModuleExchangeConfigurationSchema = z
  .strictObject({
    bindings: z.array(ModulePeerBindingSchema).max(1024),
  })
  .superRefine((value, context) => {
    const pairs = value.bindings.map((item) =>
      JSON.stringify([modulePeerKey(item.consumer), modulePeerKey(item.target)]),
    )
    if (
      new Set(pairs).size !== pairs.length ||
      new Set(value.bindings.map((item) => item.id)).size !== value.bindings.length
    )
      context.addIssue({ code: 'custom', message: 'Duplicate module permission relationship' })
  })
export type ModuleExchangeConfiguration = z.infer<typeof ModuleExchangeConfigurationSchema>
export type ModulePeerBinding = z.infer<typeof ModulePeerBindingSchema>
export const ModuleActionPhaseSchema = z.enum(['started', 'completed', 'failed', 'cancelled'])
export const ModuleActionActivitySchema = z.strictObject({
  actionId: Id,
  executionId: z.string().min(1).max(160),
  phase: ModuleActionPhaseSchema,
})
export const ModuleExchangeSubscriptionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('data'),
    target: ModulePeerSchema,
    id: Id,
    version: z.int().positive(),
  }),
  z.strictObject({
    kind: z.literal('actions'),
    target: ModulePeerSchema,
    actionIds: z.array(Id).min(1).max(256),
    phases: z.array(ModuleActionPhaseSchema).min(1).max(4),
  }),
])
export type ModuleExchangeSubscription = z.infer<typeof ModuleExchangeSubscriptionSchema>
const Provider = {
  provider: ModulePeerSchema,
  generation: z.uuid().nullable(),
  observedAt: z.iso.datetime(),
}
export const ModuleExchangeNotificationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...Provider,
    kind: z.literal('data'),
    id: Id,
    version: z.int().positive(),
    value: z.json(),
  }),
  z.strictObject({
    ...Provider,
    ...ModuleActionActivitySchema.shape,
    kind: z.literal('action'),
    source: z.enum(['hubble', 'module']),
    completion: z.string().max(96).optional(),
  }),
  z.strictObject({
    ...Provider,
    kind: z.literal('availability'),
    available: z.boolean(),
    reason: z.enum(['ready', 'unavailable', 'overflow']),
  }),
])
export type ModuleExchangeNotification = z.infer<typeof ModuleExchangeNotificationSchema>
export const ModuleExchangeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('discover') }),
  z.strictObject({ operation: z.literal('bindings') }),
  z.strictObject({
    operation: z.literal('query'),
    target: ModulePeerSchema,
    id: Id,
    version: z.int().positive(),
    input: z.json(),
  }),
  z.strictObject({
    operation: z.literal('publish'),
    id: Id,
    version: z.int().positive(),
    value: z.json(),
  }),
  z.strictObject({ operation: z.literal('report-action'), activity: ModuleActionActivitySchema }),
  z.strictObject({
    operation: z.literal('subscribe'),
    subscriptionId: Id,
    subscription: ModuleExchangeSubscriptionSchema,
  }),
  z.strictObject({ operation: z.literal('unsubscribe'), subscriptionId: Id }),
  z.strictObject({
    operation: z.literal('execute'),
    target: ModulePeerSchema,
    actionId: Id,
    fields: z.record(z.string().max(96), z.json()),
  }),
])
export const ModulePeerDescriptionSchema = z.strictObject({
  peer: ModulePeerSchema,
  name: z.string().max(160),
  available: z.boolean(),
  actionsAllowed: z.boolean(),
  data: z.array(ModuleDataDefinitionSchema).max(64),
  actions: z.array(z.strictObject({ id: Id, label: z.string().max(160) })).max(256),
})
export type ModulePeerDescription = z.infer<typeof ModulePeerDescriptionSchema>
export interface ModuleDataQuery {
  readonly id: string
  readonly version: number
  readonly input: ModuleJsonValue
}
export interface ModuleExchange {
  discover(signal?: AbortSignal): Promise<ModulePeerDescription[]>
  bindings(signal?: AbortSignal): Promise<ModulePeerBinding[]>
  query(target: ModulePeer, query: ModuleDataQuery, signal?: AbortSignal): Promise<ModuleJsonValue>
  publish(id: string, version: number, value: ModuleJsonValue): Promise<void>
  reportAction(activity: z.infer<typeof ModuleActionActivitySchema>): Promise<void>
  subscribe(
    subscription: ModuleExchangeSubscription,
    listener: (event: ModuleExchangeNotification) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>
  execute(
    target: ModulePeer,
    actionId: string,
    fields: ModuleValues,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof ModuleActionResultSchema>>
}
