export * from './exchange.js'
import {
  ModuleExchangeDefinitionSchema,
  type ModuleExchange,
  type ModuleDataQuery,
} from './exchange-contracts.js'
import { z } from 'zod'
import { ModuleVersionSchema, type ModuleInstanceScope } from './identity.js'
import { ModuleHostRequirementsSchema } from './compatibility.js'
export * from './identity.js'
export * from './choices.js'
export * from './saved-actions.js'
export * from './host-services.js'
import type { ModuleHostServices } from './host-services.js'
import type { ModuleSavedActions } from './saved-actions.js'
import type { ModuleChoiceQuery, ModuleChoicePage } from './choices.js'
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
export * from './fields.js'
import {
  ModuleFieldsSchema as FieldsSchema,
  moduleFieldsRequireV2,
  moduleFieldDefault,
  moduleFieldsContainSecrets,
  validateModuleFields,
  type ModuleChoice,
} from './fields.js'
/** Declarative screens: the host renders controls; packages never supply renderer code. */
export const ModulePageTableSchema = z.strictObject({
  type: z.literal('table'),
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  description: DescriptionSchema.optional(),
  source: z.enum(['settings', 'state']),
  columns: FieldsSchema.refine(
    (fields) => fields.length > 0 && fields.length <= 32,
    'Expected 1–32 columns',
  ),
  maxRows: z.int().min(1).max(512),
})
export const ModulePageSchema = z.strictObject({
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  description: DescriptionSchema.optional(),
  sections: z
    .array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('settings'),
          id: ModuleIdentifierSchema,
          label: LabelSchema,
          fields: z.array(ModuleIdentifierSchema).min(1).max(128),
        }),
        ModulePageTableSchema,
        z.strictObject({
          type: z.literal('status'),
          id: ModuleIdentifierSchema,
          label: LabelSchema,
          fields: z
            .array(z.strictObject({ id: ModuleIdentifierSchema, label: LabelSchema }))
            .max(32),
        }),
      ]),
    )
    .min(1)
    .max(16),
})
export const ModuleTableRowsSchema = z
  .array(
    z.strictObject({
      id: ModuleIdentifierSchema,
      values: z.record(ModuleIdentifierSchema, z.json()),
    }),
  )
  .max(512)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate table row ID' })
  })
export type ModulePage = z.infer<typeof ModulePageSchema>
export type ModulePageTable = z.infer<typeof ModulePageTableSchema>
export type ModuleTableRow = z.infer<typeof ModuleTableRowsSchema>[number]

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
    savedActionVersion: z.int().min(1).max(65_535).optional(),
    entry: ModuleFilePathSchema.refine(
      (value) => value.endsWith('.mjs'),
      'Entry must be bundled ESM (.mjs)',
    ),
    files: z.array(ModuleFilePathSchema).min(1).max(128),
    capabilities: z.array(ModuleIdentifierSchema).max(128),
    settings: FieldsSchema,
    actions: z.array(ModuleActionSchema).max(256),
    feedback: z.array(ModuleFeedbackDefinitionSchema).max(256),
    pages: z.array(ModulePageSchema).max(16).optional(),
    exchange: ModuleExchangeDefinitionSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    if (
      manifest.exchange &&
      !(
        'requiredFeatures' in manifest.host &&
        manifest.host.requiredFeatures?.includes('module-exchange-v1')
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'Module exchange requires module-exchange-v1',
      })
    if (
      manifest.savedActionVersion !== undefined &&
      (!('requiredFeatures' in manifest.host) ||
        !manifest.host.requiredFeatures?.includes('module-saved-actions-v1'))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'Saved action migrations require module-saved-actions-v1',
      })
    const fieldSets = [
      manifest.settings,
      ...manifest.actions.map((action) => action.fields),
      ...manifest.feedback.map((feedback) => feedback.fields),
      ...(manifest.pages ?? []).flatMap((page) =>
        page.sections.flatMap((section) => (section.type === 'table' ? [section.columns] : [])),
      ),
    ]
    if (
      fieldSets.some(moduleFieldsRequireV2) &&
      (!('requiredFeatures' in manifest.host) ||
        !manifest.host.requiredFeatures?.includes('module-fields-v2'))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message: 'Rich fields require module-fields-v2',
      })

    if (!manifest.files.includes(manifest.entry))
      ctx.addIssue({ code: 'custom', path: ['entry'], message: 'Entry is not listed in files' })
    for (const key of ['files', 'capabilities', 'actions', 'feedback'] as const) {
      const values = manifest[key].map((value) => (typeof value === 'string' ? value : value.id))
      const normalized = key === 'files' ? values.map((value) => value.toLowerCase()) : values
      if (new Set(normalized).size !== normalized.length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Duplicate identity' })
    }
    if (manifest.pages?.length) {
      if (
        !('requiredFeatures' in manifest.host) ||
        !manifest.host.requiredFeatures?.includes('module-pages-v1')
      )
        ctx.addIssue({ code: 'custom', path: ['host'], message: 'Pages require module-pages-v1' })
      const pageIds = new Set<string>()
      const tableIds = new Set<string>()
      const settings = new Set(manifest.settings.map((field) => field.id))
      manifest.pages.forEach((page, pageIndex) => {
        if (pageIds.has(page.id))
          ctx.addIssue({
            code: 'custom',
            path: ['pages', pageIndex, 'id'],
            message: 'Duplicate page ID',
          })
        pageIds.add(page.id)
        const sectionIds = new Set<string>()
        page.sections.forEach((section, sectionIndex) => {
          const path = ['pages', pageIndex, 'sections', sectionIndex]
          if (sectionIds.has(section.id))
            ctx.addIssue({ code: 'custom', path, message: 'Duplicate section ID' })
          sectionIds.add(section.id)
          if (
            section.type === 'settings' &&
            (new Set(section.fields).size !== section.fields.length ||
              section.fields.some((id) => !settings.has(id)))
          )
            ctx.addIssue({
              code: 'custom',
              path,
              message: 'Settings sections must reference unique declared fields',
            })
          if (section.type === 'table') {
            const key = `${section.source}:${section.id}`
            if (tableIds.has(key) || (section.source === 'settings' && settings.has(section.id)))
              ctx.addIssue({
                code: 'custom',
                path,
                message: 'Table storage keys must be unique and separate from settings fields',
              })
            tableIds.add(key)
            if (moduleFieldsContainSecrets(section.columns))
              ctx.addIssue({
                code: 'custom',
                path,
                message: 'Secret fields belong in settings forms, not spreadsheet cells',
              })
            if (section.source === 'settings') {
              try {
                validateModuleFields(
                  section.columns,
                  Object.fromEntries(
                    section.columns.map((field) => [field.id, moduleFieldDefault(field)]),
                  ),
                )
              } catch {
                ctx.addIssue({
                  code: 'custom',
                  path,
                  message: 'Editable table columns need valid defaults for new rows',
                })
              }
            }
          }
        })
      })
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
  /** Local, instance-scoped runtime state across package versions. Never included in workspace exports. Access only after start. */
  readonly runtimeDirectory?: string

  /** Module communication routed and authorized by Hubble. Requires module-exchange-v1. */
  readonly modules?: ModuleExchange
  /** Requires host-service-registry-v1; available after start, with the same scope and origin grants as requestHost. */
  readonly services?: ModuleHostServices
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
  /** Read-only public data query. Never execute controls from this callback. */
  queryData?(
    query: ModuleDataQuery,
    context: { readonly signal: AbortSignal },
  ): Promise<ModuleJsonValue> | ModuleJsonValue
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
  /** Read-only discovery. Draft values never become settings or execute a command. */
  discoverChoices?(
    query: ModuleChoiceQuery,
    context: { readonly signal: AbortSignal },
  ): ModuleChoicePage | Promise<ModuleChoicePage>
}
export interface HubbleModule {
  /** Pure migration of this instance's saved action/feedback expressions. Stable keys must remain unchanged. */
  migrateSavedActions?(
    actions: Readonly<ModuleSavedActions>,
    fromVersion: number,
    toVersion: number,
  ): ModuleSavedActions | Promise<ModuleSavedActions>
  createInstance(context: ModuleContext): ModuleInstance
  /** Pure data migration. No network calls or device commands; input is never mutated. */
  migrateConfig?(
    settings: ModuleValues,
    fromVersion: number,
    toVersion: number,
  ): Promise<ModuleValues> | ModuleValues
}

/** The same validation applies to edits, migrations, selection and automatic updates. */
export function validateModuleSettings(manifest: ModuleManifest, values: ModuleValues): void {
  validateModuleFields(manifest.settings, values)
  for (const page of manifest.pages ?? [])
    for (const section of page.sections) {
      if (
        section.type !== 'table' ||
        section.source !== 'settings' ||
        values[section.id] === undefined
      )
        continue
      const rows = ModuleTableRowsSchema.parse(values[section.id])
      if (rows.length > section.maxRows) throw new Error(`Too many rows in ${section.label}`)
      for (const row of rows) validateModuleFields(section.columns, row.values)
    }
}
