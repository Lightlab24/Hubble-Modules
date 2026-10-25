import { z } from 'zod'
import { ButtonInteractionSchema } from './button-interactions.js'
import { ActionColumnIdSchema, RgbHexSchema, SafeIdentifierSchema } from './primitives.js'

export function normalizeCccIp(value: string): string {
  const ip = value
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
  if (z.ipv6().safeParse(ip).success) return new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  return ip
}

export const CccIpSchema = z
  .string()
  .transform(normalizeCccIp)
  .refine(
    (ip) => ip === '' || z.ipv4().safeParse(ip).success || z.ipv6().safeParse(ip).success,
    'Enter an IPv4 or IPv6 address',
  )

export const CccRowSchema = z
  .strictObject({
    rowId: z.uuid(),
    enabled: z.boolean(),
    rcpIp: CccIpSchema,
    cameraNumber: z.int().min(1).max(999_999).nullable(),
  })
  .readonly()

export type CccRow = z.infer<typeof CccRowSchema>

export function cccTargetKey(row: Pick<CccRow, 'rcpIp' | 'cameraNumber'>): string | null {
  return row.rcpIp && row.cameraNumber !== null
    ? `${normalizeCccIp(row.rcpIp)}/${String(row.cameraNumber)}`
    : null
}

export const CccRowsSchema = z
  .array(CccRowSchema)
  .max(512)
  .superRefine((rows, context) => {
    const ids = new Set<string>()
    const targets = new Set<string>()
    rows.forEach((row, index) => {
      const target = cccTargetKey(row)
      if (ids.has(row.rowId))
        context.addIssue({
          code: 'custom',
          path: [index, 'rowId'],
          message: 'Duplicate CCC row ID',
        })
      if (target !== null && targets.has(target))
        context.addIssue({
          code: 'custom',
          path: [index, 'cameraNumber'],
          message: 'This RCP and camera number already exist in CCC',
        })
      ids.add(row.rowId)
      if (target !== null) targets.add(target)
    })
  })
  .readonly()

export const CccConfigSchema = z
  .strictObject({
    revision: z.int().min(0),
    rows: CccRowsSchema,
  })
  .readonly()

export type CccConfig = z.infer<typeof CccConfigSchema>

export const EMPTY_CCC: CccConfig = Object.freeze({ revision: 0, rows: Object.freeze([]) })

export const CccCommandSchema = z.enum([
  'enable-camera',
  'disable-camera',
  'toggle-camera-enabled',
  'enable-all-cameras',
  'roll-enabled-cameras',
  'stop-enabled-cameras',
  'roll-toggle-enabled-cameras',
  'nd-up-enabled-cameras',
  'nd-down-enabled-cameras',
  'iso-up-enabled-cameras',
  'iso-down-enabled-cameras',
])

export type CccCommand = z.infer<typeof CccCommandSchema>

export const CCC_FEEDBACK_ACTIVE_COLOR = '#37A65B'

export const CCC_FEEDBACK_INACTIVE_COLOR = '#3A3A40'

export function cccCommandNeedsCamera(command: unknown): boolean {
  return (
    command === 'enable-camera' ||
    command === 'disable-camera' ||
    command === 'toggle-camera-enabled'
  )
}

export function cccCommandControlsRecording(command: unknown): boolean {
  return (
    command === 'roll-enabled-cameras' ||
    command === 'stop-enabled-cameras' ||
    command === 'roll-toggle-enabled-cameras'
  )
}

export const CccMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('replace'),
    expectedRevision: z.int().min(0),
    rows: CccRowsSchema,
  }),
  z.strictObject({
    kind: z.literal('enabled'),
    rowId: z.uuid(),
    enabled: z.union([z.boolean(), z.literal('toggle')]),
  }),
  z.strictObject({ kind: z.literal('enable-all') }),
])

export type CccMutation = z.infer<typeof CccMutationSchema>

export function applyCccMutation(current: CccConfig, mutation: CccMutation): CccConfig {
  if (mutation.kind === 'replace' && mutation.expectedRevision !== current.revision)
    throw new Error('CCC changed in another control. Reload the sheet and try again.')
  if (mutation.kind === 'enabled' && !current.rows.some((row) => row.rowId === mutation.rowId))
    throw new Error('CCC camera row no longer exists')
  const rows =
    mutation.kind === 'replace'
      ? mutation.rows
      : current.rows.map((row) => {
          if (mutation.kind === 'enable-all')
            return cccTargetKey(row) === null ? row : { ...row, enabled: true }
          return row.rowId === mutation.rowId
            ? {
                ...row,
                enabled: mutation.enabled === 'toggle' ? !row.enabled : mutation.enabled,
              }
            : row
        })
  return CccConfigSchema.parse({ revision: current.revision + 1, rows })
}

export const CccResultSchema = z
  .strictObject({
    rowId: z.uuid(),
    rcpIp: z.string(),
    cameraNumber: z.int().nullable(),
    phase: z.enum(['sent', 'confirmed', 'unconfirmed', 'error']),
    message: z.string().max(512),
  })
  .readonly()

export type CccResult = z.infer<typeof CccResultSchema>

export const CccBatchResultSchema = z
  .strictObject({
    batchId: z.uuid(),
    command: CccCommandSchema,
    results: z.array(CccResultSchema).readonly(),
  })
  .readonly()

export type CccBatchResult = z.infer<typeof CccBatchResultSchema>

export const CccRowLiveStateSchema = z
  .strictObject({
    rowId: z.uuid(),
    name: z.string(),
    connection: z.enum(['incomplete', 'connecting', 'online', 'offline', 'error']),
    recording: z.enum(['recording', 'stopped', 'unknown']),
    message: z.string(),
    lastResult: CccResultSchema.nullable(),
  })
  .readonly()

export const CccStateSchema = z
  .strictObject({
    workspaceId: z.uuid(),
    config: CccConfigSchema,
    rows: z.array(CccRowLiveStateSchema).readonly(),
  })
  .readonly()

export type CccState = z.infer<typeof CccStateSchema>

export const CccMutationRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  mutation: CccMutationSchema,
})

export const CccCommandRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  command: CccCommandSchema,
  rowId: z.uuid().optional(),
})

export type CccMutationRequest = z.infer<typeof CccMutationRequestSchema>

export type CccCommandRequest = z.infer<typeof CccCommandRequestSchema>

export const CccActionSchema = z
  .strictObject({
    type: z.literal('ccc.command'),
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    enabled: z.boolean(),
    command: CccCommandSchema,
    rowId: z.uuid().nullable(),
    drivesTally: z.boolean().default(true),
    feedbackColor: RgbHexSchema.prefault(CCC_FEEDBACK_ACTIVE_COLOR),
    feedbackInactiveColor: RgbHexSchema.nullable().prefault(CCC_FEEDBACK_INACTIVE_COLOR),
  })
  .readonly()
