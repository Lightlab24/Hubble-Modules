import { z } from 'zod'

export const ModuleOrderedNumbersSchema = z
  .strictObject({
    min: z.int(),
    max: z.int(),
    minItems: z.int().min(1).max(64).default(1),
    maxItems: z.int().min(1).max(64),
    itemLabel: z.string().min(1).max(80).default('Item'),
  })
  .refine(
    (value) => value.min <= value.max && value.minItems <= value.maxItems,
    'Invalid ordered-number bounds',
  )
export type ModuleOrderedNumbers = z.infer<typeof ModuleOrderedNumbersSchema>

export function parseModuleOrderedNumbers(
  input: unknown,
  definition: ModuleOrderedNumbers,
): { success: true; values: number[]; canonical: string } | { success: false; message: string } {
  if (typeof input !== 'string' && typeof input !== 'number')
    return { success: false, message: 'Enter an ordered list of numbers' }
  const parts = String(input)
    .trim()
    .split(',')
    .map((part) => part.trim())
  if (parts.length < definition.minItems || parts.length > definition.maxItems)
    return {
      success: false,
      message: `Enter ${String(definition.minItems)}–${String(definition.maxItems)} items`,
    }
  if (parts.some((part) => !/^-?\d+$/u.test(part)))
    return { success: false, message: 'Use whole numbers separated by commas' }
  const values = parts.map(Number)
  if (
    values.some(
      (value) => !Number.isSafeInteger(value) || value < definition.min || value > definition.max,
    )
  )
    return {
      success: false,
      message: `Use numbers from ${String(definition.min)} to ${String(definition.max)}`,
    }
  if (new Set(values).size !== values.length)
    return { success: false, message: 'Choose each item once' }
  return { success: true, values, canonical: values.join(', ') }
}

const Color = z.string().regex(/^#[0-9a-f]{6}$/iu)
export const ModuleColorPaletteSchema = z.strictObject({
  defaults: z.array(Color).min(1).max(16),
  itemsField: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u),
  itemLabel: z.string().min(1).max(80).default('Item'),
})
export type ModuleColorPalette = z.infer<typeof ModuleColorPaletteSchema>

/** Keep dormant position colours and the single-item colour in the same source expression. */
export function parseModuleColorPalette(
  source: string,
  size: number,
): { singletonColor: string; cycleColors: string[] | null } | null {
  if (!Number.isSafeInteger(size) || size < 1 || size > 16 || source.length > 4096) return null
  const parts = source.trim().split(';cycle=')
  const singleton = Color.safeParse(parts[0]?.trim())
  if (!singleton.success || parts.length > 2) return null
  if (parts.length === 1) return { singletonColor: singleton.data, cycleColors: null }
  const cycle = z
    .array(Color)
    .length(size)
    .safeParse(parts[1]?.split('|').map((item) => item.trim()))
  return cycle.success ? { singletonColor: singleton.data, cycleColors: cycle.data } : null
}
export function formatModuleColorPalette(singleton: string, colors: readonly string[]): string {
  const values = z.array(Color).min(1).max(16).parse(colors)
  return `${Color.parse(singleton)};cycle=${values.join('|')}`
}
