import { z } from 'zod'
import { ModuleVersionSchema, type ModuleInstanceScope } from './identity.js'
import { ModuleHostRequirementsSchema } from './compatibility.js'
export * from './identity.js'
export * from './compatibility.js'
export * from './release-metadata.js'

/** API 1: qualified with the HTTP Requests and DIT Browse external pilots. */
export const MODULE_API_VERSION = 1 as const
export const MODULE_GESTURES = [
  'press',
  'rotate-left',
  'rotate-right',
  'long-press-1s',
  'long-press-2s',
  'long-press-3s',
] as const

export const ModuleIdSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u)
export const ModuleIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
export const ModuleFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes('\\') &&
      !value.includes(':') &&
      value
        .split('/')
        .every(
          (part) =>
            /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part) &&
            !part.endsWith('.') &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
        ),
    'Expected a portable relative file path without traversal or special segments',
  )
const LabelSchema = z.string().trim().min(1).max(160)
const DescriptionSchema = z.string().trim().min(1).max(1_000)
/** Presentation only. Group labels never form part of a saved choice identity. */
export const ModuleChoiceSchema = z.strictObject({
  id: z.string().max(160),
  label: z.string().max(160),
  group: LabelSchema.optional(),
})
export type ModuleChoice = z.infer<typeof ModuleChoiceSchema>
const FieldBase = {
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  required: z.boolean(),
  description: DescriptionSchema.optional(),
}
export const ModuleFieldSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...FieldBase,
    type: z.literal('text'),
    default: z.string().max(16_384),
    secret: z.boolean().optional(),
  }),
  z.strictObject({
    ...FieldBase,
    type: z.literal('number'),
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.strictObject({ ...FieldBase, type: z.literal('boolean'), default: z.boolean() }),
  z.strictObject({
    ...FieldBase,
    type: z.literal('choice'),
    default: z.string().max(160),
    choices: z
      .array(ModuleChoiceSchema.extend({ id: z.string().min(1).max(160), label: LabelSchema }))
      .max(1_024),
    choiceProvider: ModuleIdentifierSchema.optional(),
  }),
])
const FieldsSchema = z
  .array(ModuleFieldSchema)
  .max(128)
  .superRefine((fields, ctx) => {
    const ids = new Set<string>()
    fields.forEach((field, index) => {
      if (ids.has(field.id))
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'Duplicate field ID' })
      ids.add(field.id)
      if (
        field.type === 'number' &&
        ((field.min !== undefined && field.default < field.min) ||
          (field.max !== undefined && field.default > field.max) ||
          (field.min !== undefined && field.max !== undefined && field.min > field.max))
      ) {
        ctx.addIssue({ code: 'custom', path: [index], message: 'Number default/bounds conflict' })
      }
      if (field.type === 'choice') {
        if (new Set(field.choices.map((item) => item.id)).size !== field.choices.length) {
          ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate choice ID' })
        }
        if (!field.choiceProvider && !field.choices.some((choice) => choice.id === field.default)) {
          ctx.addIssue({ code: 'custom', path: [index], message: 'Choice default is missing' })
        }
      }
    })
  })
export const ModuleCompletionSchema = z.enum(['local', 'submitted', 'response', 'state-confirmed'])
export const ModuleActionSchema = z.strictObject({
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  group: LabelSchema.optional(),
  description: DescriptionSchema,
  fields: FieldsSchema,
  legacy: z.boolean().optional(),
  completion: ModuleCompletionSchema,
  completionAlternatives: z.array(ModuleCompletionSchema).max(3).optional(),
  timeoutMs: z.int().min(25).max(120_000),
})
export const ModuleFeedbackDefinitionSchema = z.strictObject({
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  group: LabelSchema.optional(),
  description: DescriptionSchema,
  fields: FieldsSchema,
})
export const ModuleManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: ModuleIdSchema,
    name: LabelSchema,
    version: ModuleVersionSchema,
    apiVersion: z.literal(MODULE_API_VERSION),
    host: ModuleHostRequirementsSchema,
    configVersion: z.int().min(1).max(65_535),
    entry: ModuleFilePathSchema.refine(
      (value) => value.endsWith('.mjs'),
      'Entry must be bundled ESM (.mjs)',
    ),
    files: z.array(ModuleFilePathSchema).min(1).max(128),
    capabilities: z.array(ModuleIdentifierSchema).max(128),
    settings: FieldsSchema,
    actions: z.array(ModuleActionSchema).max(256),
    feedback: z.array(ModuleFeedbackDefinitionSchema).max(256),
  })
  .superRefine((manifest, ctx) => {
    if (!manifest.files.includes(manifest.entry))
      ctx.addIssue({ code: 'custom', path: ['entry'], message: 'Entry is not listed in files' })
    for (const key of ['files', 'capabilities', 'actions', 'feedback'] as const) {
      const values = manifest[key].map((value) => (typeof value === 'string' ? value : value.id))
      const normalized = key === 'files' ? values.map((value) => value.toLowerCase()) : values
      if (new Set(normalized).size !== normalized.length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate identity' })
    }
  })

export const ModuleActionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    evidence: z.strictObject({ kind: ModuleCompletionSchema, summary: DescriptionSchema }),
  }),
  z.strictObject({
    status: z.literal('failure'),
    category: z.enum([
      'invalid-config',
      'unavailable',
      'timeout',
      'cancelled',
      'rejected',
      'internal',
    ]),
    message: DescriptionSchema,
    /** Stable integration-specific failure identity, retained by legacy adapters. */
    code: ModuleIdentifierSchema.optional(),
  }),
])
export const ModuleFeedbackSchema = z
  .strictObject({
    id: ModuleIdentifierSchema,
    state: z.enum(['active', 'inactive', 'unavailable']),
    observedAt: z.iso.datetime().nullable(),
    fields: z.record(z.string().max(96), z.json()).optional(),
  })
  .refine(
    (feedback) => feedback.state === 'unavailable' || feedback.observedAt !== null,
    'Known feedback needs an observation timestamp',
  )

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>
export type ModuleActionResult = z.infer<typeof ModuleActionResultSchema>
export type ModuleFeedback = z.infer<typeof ModuleFeedbackSchema>
export type ModuleJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ModuleJsonValue[]
  | { readonly [key: string]: ModuleJsonValue }
export type ModuleValues = Readonly<Record<string, ModuleJsonValue>>

export const ModuleStateSchema = z.strictObject({
  phase: z.enum(['starting', 'connecting', 'ready', 'unavailable', 'error']),
  message: z.string().max(1_000).nullable(),
  observedAt: z.iso.datetime(),
  values: z.record(z.string().max(96), z.json()).default({}),
})
export type ModuleState = z.infer<typeof ModuleStateSchema>
export function moduleFeedbackKey(id: string, fields: ModuleValues = {}): string {
  const canonical = (value: ModuleJsonValue): ModuleJsonValue =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value
  return JSON.stringify([id, canonical(fields)])
}

export interface ModuleTrace {
  readonly level: 'debug' | 'info' | 'error'
  readonly stage: string
  readonly message: string
}
export interface ModuleContext {
  readonly instanceId: string
  readonly scope: ModuleInstanceScope
  readonly settings: ModuleValues
  /** Host adds package identity, generation and instance to every observation. */
  log(trace: ModuleTrace): void
  publishFeedback(feedback: ModuleFeedback): void
  publishState(state: ModuleState): void
  /** Versioned service observations for host-owned views. Never a device command. */
  publishEvent?(channel: string, value: ModuleJsonValue): void
  /** Declared host capabilities only; unavailable during prepare/migration. */
  requestHost?(
    method: string,
    value: ModuleJsonValue,
    signal?: AbortSignal,
  ): Promise<ModuleJsonValue>
}
export interface ModuleExecutionContext {
  readonly executionId: string
  readonly signal: AbortSignal
  readonly gesture: (typeof MODULE_GESTURES)[number]
  readonly wrap: boolean
  log(trace: ModuleTrace): void
}
export interface ModuleInstance {
  /** Connect/subscribe/observe only; never issue a control action on startup. */
  start(): Promise<void> | void
  execute(
    actionId: string,
    fields: ModuleValues,
    context: ModuleExecutionContext,
  ): Promise<ModuleActionResult>
  /** Dispose is idempotent and releases all owned resources, including failed starts. */
  dispose(): Promise<void> | void
  /** Explicit service methods for host views and shared coordinators. */
  call?(
    method: string,
    value: ModuleJsonValue,
    context: Pick<ModuleExecutionContext, 'signal' | 'log'>,
  ): Promise<ModuleJsonValue> | ModuleJsonValue
  choices?(provider: string): readonly ModuleChoice[] | Promise<readonly ModuleChoice[]>
}
export interface HubbleModule {
  createInstance(context: ModuleContext): ModuleInstance
  /** Pure data migration. No network calls or device commands; input is never mutated. */
  migrateConfig?(
    settings: ModuleValues,
    fromVersion: number,
    toVersion: number,
  ): Promise<ModuleValues> | ModuleValues
}

export function validateModuleFields(
  fields: ModuleManifest['settings'],
  values: ModuleValues,
): void {
  for (const field of fields) {
    const value = values[field.id]
    if (value === undefined) {
      if (field.required) throw new Error(`Missing module field: ${field.label}`)
      continue
    }
    if (field.type === 'boolean' && typeof value !== 'boolean')
      throw new Error(`Expected a boolean for ${field.label}`)
    if (
      field.type === 'number' &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    )
      throw new Error(`Invalid number for ${field.label}`)
    if (
      field.type === 'text' &&
      (typeof value !== 'string' || value.length > 16_384 || (field.required && !value.trim()))
    )
      throw new Error(`Invalid text for ${field.label}`)
    if (
      field.type === 'choice' &&
      (typeof value !== 'string' ||
        (!field.choiceProvider && !field.choices.some((choice) => choice.id === value)))
    )
      throw new Error(`Invalid choice for ${field.label}`)
  }
}
