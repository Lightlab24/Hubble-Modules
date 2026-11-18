import { z } from 'zod'

/**
 * The channel a module publishes on to ask the operator for values in HubDash, usually from a key
 * press: Hubble brings HubDash to the front with a dialog, and on Send runs the module's `answer`
 * action with the typed values under `prompt` in its fields. Requires module-prompt-v1.
 */
export const MODULE_PROMPT_CHANNEL = 'host.prompt.v1'

/** Icons Hubble can draw in a dialog's header. */
export const ModulePromptIconSchema = z.enum(['thermometer', 'sliders', 'camera', 'gauge'])

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u)
const Text = (max: number) => z.string().trim().min(1).max(max)

export const ModulePromptFieldSchema = z
  .strictObject({
    id: Id,
    label: Text(60),
    type: z.literal('number'),
    /** What the field starts with; null starts it empty. */
    default: z.number().nullable().default(null),
    min: z.number(),
    max: z.number(),
    integer: z.boolean().default(true),
    /** Shown right after the field, such as `K`. */
    unit: z.string().trim().max(12).optional(),
    /** Shown beside the field, such as the range in the device's own terms. */
    hint: z.string().trim().max(80).optional(),
    /** An optional field left empty sends nothing for it. */
    optional: z.boolean().default(false),
  })
  .refine((field) => field.min <= field.max, { message: 'min must not be above max' })
  .refine(
    (field) => field.default === null || (field.default >= field.min && field.default <= field.max),
    { message: 'default must be within min and max' },
  )

export const ModulePromptTableSchema = z.strictObject({
  label: Text(60).optional(),
  columns: z
    .array(z.strictObject({ id: Id, label: z.string().trim().max(40) }))
    .min(1)
    .max(6),
  rows: z.array(z.record(Id, z.string().max(80))).max(64),
})

export const ModulePromptSchema = z
  .strictObject({
    /**
     * One open dialog per key and module. A new request with the same key asks again: the same
     * dialog, brought to the front, with what the operator typed kept.
     */
    key: Id,
    title: Text(80),
    description: z.string().trim().max(200).optional(),
    icon: ModulePromptIconSchema.optional(),
    fields: z.array(ModulePromptFieldSchema).min(1).max(4),
    table: ModulePromptTableSchema.optional(),
    notes: z.array(Text(200)).max(4).default([]),
    submitLabel: Text(40),
    /** The action Hubble runs on Send, with the typed values added to its fields as `prompt`. */
    answer: z.strictObject({
      actionId: Id,
      fields: z.record(z.string().max(96), z.json()),
    }),
    /** How long the dialog stays open unanswered. */
    expiresInMs: z.int().min(5_000).max(600_000).default(120_000),
    /**
     * Only refreshes the open dialog with this key, such as when the cameras it lists change,
     * keeping what the operator typed; never opens one that has closed. Requires
     * module-prompt-update-v1.
     */
    update: z.boolean().default(false),
  })
  .refine(
    (prompt) => new Set(prompt.fields.map((field) => field.id)).size === prompt.fields.length,
    {
      message: 'Prompt field ids must be unique',
    },
  )
  .refine((prompt) => JSON.stringify(prompt).length <= 65_536, {
    message: 'Prompt is too large',
  })

export type ModulePromptField = z.infer<typeof ModulePromptFieldSchema>
export type ModulePrompt = z.infer<typeof ModulePromptSchema>
export type ModulePromptInput = z.input<typeof ModulePromptSchema>

/** The typed values, by field id. An empty optional field is left out. */
export const ModulePromptValuesSchema = z.record(Id, z.number())
export type ModulePromptValues = z.infer<typeof ModulePromptValuesSchema>

/** Checks what the operator sent against the dialog it was asked for, and says what is wrong in the operator's words. */
export function checkModulePromptValues(
  fields: readonly ModulePromptField[],
  candidate: unknown,
):
  | { readonly ok: true; readonly values: ModulePromptValues }
  | { readonly ok: false; readonly message: string } {
  const parsed = ModulePromptValuesSchema.safeParse(candidate)
  if (!parsed.success) return { ok: false, message: 'Enter numbers only' }
  const known = new Set(fields.map((field) => field.id))
  if (Object.keys(parsed.data).some((id) => !known.has(id)))
    return { ok: false, message: 'The dialog changed; open it again' }
  const values: Record<string, number> = {}
  for (const field of fields) {
    const value = parsed.data[field.id]
    if (value === undefined) {
      if (field.optional) continue
      return { ok: false, message: `Enter a ${field.label.toLowerCase()}` }
    }
    if (field.integer && !Number.isInteger(value))
      return { ok: false, message: `${field.label} must be a whole number` }
    if (value < field.min || value > field.max)
      return {
        ok: false,
        message: `${field.label} must be from ${String(field.min)} to ${String(field.max)}`,
      }
    values[field.id] = value
  }
  return { ok: true, values }
}
