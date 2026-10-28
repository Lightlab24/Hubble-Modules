import { z } from 'zod'
import { ModuleInstanceScopeSchema, ModulePackageIdentitySchema } from './identity.js'
import type { ModuleJsonValue } from './index.js'

const JsonObject = z.record(z.string(), z.json())
const BundleId = z.string().min(3).max(256)
const MenuPath = z
  .array(
    z.strictObject({
      title: z.string().min(1).max(256),
      identifier: z.string().min(1).max(256).optional(),
    }),
  )
  .min(2)
  .max(12)
const RouterScope = z.strictObject({
  workspaceId: z.uuid(),
  connectionId: z.uuid(),
  moduleConnectionId: z.uuid(),
  groupId: z.uuid().nullable(),
})
const Address = z.int().min(1).max(65536)
const Levels = z.array(z.int().min(1).max(256)).max(256)
const LiveGradeScope = {
  generation: z.union([z.literal(6), z.literal(7)]),
  edition: z.enum(['standard', 'frontier', 'pro']),
  timeoutMs: z.int().positive().max(120000),
}

/** Version 1 is additive to the frozen API 1 requestHost aliases. Domain validators still run in the host. */
export const ModuleHostServiceRequests = {
  'ccc-store': z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('read') }),
    z.strictObject({
      method: z.literal('mutate'),
      request: z.strictObject({ workspaceId: z.uuid(), mutation: JsonObject }),
    }),
  ]),
  keyboard: z.discriminatedUnion('operation', [
    z.strictObject({ operation: z.literal('list-applications') }),
    z.strictObject({
      operation: z.literal('list-menu-commands'),
      bundleId: BundleId,
      cursor: z.string().max(1024).optional(),
    }),
    z.strictObject({
      operation: z.literal('select-menu-item'),
      bundleId: BundleId,
      menuPath: MenuPath,
    }),
    z.strictObject({ operation: z.literal('activate-application'), bundleId: BundleId }),
    z.strictObject({ operation: z.literal('open-application'), bundleId: BundleId }),
    z.strictObject({
      operation: z.literal('send-shortcut'),
      key: z.string().min(1).max(64),
      modifiers: z.array(z.enum(['command', 'control', 'option', 'shift'])).max(4),
      target: z.discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('global') }),
        z.strictObject({ mode: z.literal('application'), bundleId: BundleId }),
      ]),
    }),
  ]),
  tsl: z.strictObject({
    method: z.enum([
      'toggle-tally-follow',
      'set-tally-follow',
      'toggle-column-follow',
      'set-column-follow',
      'set-indication',
    ]),
    columnId: z.uuid().optional(),
    enabled: z.boolean(),
  }),
  'router-groups': z.discriminatedUnion('method', [
    z.strictObject({
      method: z.literal('selectSource'),
      input: RouterScope.extend({ source: Address, levels: Levels }),
    }),
    z.strictObject({
      method: z.literal('selectDestination'),
      input: RouterScope.extend({ destination: Address }),
    }),
    z.strictObject({
      method: z.literal('cycleDestination'),
      input: RouterScope.extend({
        destinations: z.array(Address).min(1).max(65536),
        step: z.union([z.literal(-1), z.literal(1)]),
        wrap: z.boolean(),
      }),
    }),
    z.strictObject({ method: z.literal('take'), input: RouterScope.extend({ levels: Levels }) }),
    z.strictObject({
      method: z.literal('toggleGroupEnabled'),
      input: RouterScope.extend({ groupId: z.uuid() }),
    }),
  ]),
  livegrade: z.discriminatedUnion('method', [
    z.strictObject({ method: z.literal('probe'), ...LiveGradeScope }),
    z.strictObject({ method: z.literal('permission'), ...LiveGradeScope }),
    z.strictObject({
      method: z.literal('select'),
      ...LiveGradeScope,
      position: z.int().min(1).max(4096),
    }),
  ]),
} as const
export const ModuleHostServiceIdSchema = z.enum([
  'ccc-store',
  'keyboard',
  'tsl',
  'router-groups',
  'livegrade',
])
export type ModuleHostServiceId = z.infer<typeof ModuleHostServiceIdSchema>
export type ModuleHostServiceRequest<S extends ModuleHostServiceId> = z.infer<
  (typeof ModuleHostServiceRequests)[S]
>
export const ModuleHostServiceResponses = {
  'ccc-store': JsonObject,
  keyboard: z
    .object({
      available: z.boolean(),
      permissionGranted: z.boolean(),
      sent: z.boolean(),
      completed: z.boolean().optional(),
      errorCode: z.string().nullable(),
      message: z.string().nullable(),
      applications: z
        .array(
          z.strictObject({
            name: z.string(),
            bundleId: z.string(),
            pid: z.int().positive().nullable(),
          }),
        )
        .max(256),
    })
    .catchall(z.json()),
  tsl: z.null(),
  'router-groups': z.null(),
  livegrade: JsonObject,
} as const
export type ModuleHostServiceResponse<S extends ModuleHostServiceId> = z.infer<
  (typeof ModuleHostServiceResponses)[S]
>
export const ModuleHostServiceCallSchema = z.strictObject({
  service: ModuleHostServiceIdSchema,
  version: z.literal(1),
  input: z.json(),
})
export const ModuleHostServiceDefinitionSchema = z.strictObject({
  service: ModuleHostServiceIdSchema,
  version: z.literal(1),
  capability: z.string(),
  readOperations: z.array(z.string()),
  commandOrigins: z.tuple([z.literal('execute'), z.literal('call')]),
  requestSchema: JsonObject,
  responseSchema: JsonObject,
})
export const ModuleHostServiceGrantSchema = z.strictObject({
  service: ModuleHostServiceIdSchema,
  version: z.literal(1),
  declared: z.boolean(),
  granted: z.boolean(),
  available: z.boolean(),
})
export const ModuleHostServiceScopeSchema = z.strictObject({
  scope: ModuleInstanceScopeSchema,
  identity: ModulePackageIdentitySchema,
  services: z.array(ModuleHostServiceGrantSchema).max(5),
})
export const ModuleHostServiceRegistrySchema = z.strictObject({
  version: z.literal(1),
  definitions: z.array(ModuleHostServiceDefinitionSchema).max(5),
  scopes: z.array(ModuleHostServiceScopeSchema).max(259),
})
export const MODULE_HOST_SERVICE_DEFINITIONS = ModuleHostServiceIdSchema.options.map((service) =>
  ModuleHostServiceDefinitionSchema.parse({
    service,
    version: 1,
    capability: `host.${service}`,
    commandOrigins: ['execute', 'call'],
    readOperations: service === 'ccc-store' ? ['read'] : service === 'livegrade' ? ['probe'] : [],
    requestSchema: z.toJSONSchema(ModuleHostServiceRequests[service]),
    responseSchema: z.toJSONSchema(ModuleHostServiceResponses[service]),
  }),
)

export interface ModuleHostServices {
  describe(signal?: AbortSignal): Promise<z.infer<typeof ModuleHostServiceScopeSchema>>
  request<S extends ModuleHostServiceId>(
    service: S,
    version: 1,
    input: ModuleHostServiceRequest<S>,
    signal?: AbortSignal,
  ): Promise<ModuleHostServiceResponse<S>>
}
export function createModuleHostServices(
  requestHost: (
    method: string,
    value: ModuleJsonValue,
    signal?: AbortSignal,
  ) => Promise<ModuleJsonValue>,
): ModuleHostServices {
  return {
    async describe(signal) {
      return ModuleHostServiceScopeSchema.parse(
        await requestHost('describe-host-services', null, signal),
      )
    },
    async request<S extends ModuleHostServiceId>(
      service: S,
      version: 1,
      input: ModuleHostServiceRequest<S>,
      signal?: AbortSignal,
    ): Promise<ModuleHostServiceResponse<S>> {
      const value = ModuleHostServiceCallSchema.parse({
        service,
        version,
        input: ModuleHostServiceRequests[service].parse(input),
      })
      return ModuleHostServiceResponses[service].parse(
        await requestHost('service', value, signal),
      ) as ModuleHostServiceResponse<S>
    },
  }
}
