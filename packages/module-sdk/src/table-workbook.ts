import {
  ModuleTableRowsSchema,
  type ModuleValues,
  type ModuleTableRow,
  type ModulePageTable,
} from './index.js'
import { z } from 'zod'

const Identifier = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u)
const uniqueIdentifiers = (maximum: number) =>
  z
    .array(Identifier)
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate identity')
const boundedRecord = <T extends z.ZodType>(schema: T, maximum: number) =>
  z
    .record(Identifier, schema)
    .refine((record) => Object.keys(record).length <= maximum, 'Too many entries')

/** Portable operator choices. Selection, scroll position and open editors are transient. */
export const ModuleTableViewStateSchema = z
  .strictObject({
    version: z.literal(1),
    columnOrder: uniqueIdentifiers(32).default([]),
    hiddenColumns: uniqueIdentifiers(32).default([]),
    columnWidths: boundedRecord(z.number().min(48).max(800), 32).default({}),
    rowHeights: boundedRecord(z.number().min(28).max(400), 512).default({}),
    textSize: z.int().min(9).max(24).default(12),
    frozenColumns: z.int().min(0).max(32).default(0),
    sheets: z
      .array(
        z.strictObject({
          id: Identifier,
          name: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[^\u0000-\u001f\u007f]+$/u),
        }),
      )
      .min(1)
      .max(32)
      .default([{ id: 'sheet-1', name: 'Sheet 1' }]),
    sheetByRowId: boundedRecord(Identifier, 512).default({}),
  })
  .superRefine((view, context) => {
    const ids = new Set(view.sheets.map((sheet) => sheet.id))
    const names = new Set(view.sheets.map((sheet) => sheet.name.toLowerCase()))
    if (ids.size !== view.sheets.length || names.size !== view.sheets.length)
      context.addIssue({ code: 'custom', message: 'Sheet identities and names must be unique' })
    if (Object.values(view.sheetByRowId).some((id) => !ids.has(id)))
      context.addIssue({
        code: 'custom',
        message: 'Row assignments must reference an existing sheet',
      })
  })
export type ModuleTableViewState = z.infer<typeof ModuleTableViewStateSchema>

/** A native workbook uses the host's existing spreadsheet controls, never module renderer code. */
export const ModuleTableWorkbookSchema = z.strictObject({
  stateKey: Identifier,
  columns: boundedRecord(
    z.strictObject({
      editor: z.enum(['text', 'color']).optional(),
      formula: z.boolean().optional(),
      fill: z.enum(['copy', 'series']).optional(),
      duplicate: z.enum(['copy', 'default']).optional(),
      width: z.number().min(48).max(800).optional(),
    }),
    32,
  ).optional(),
  defaults: z
    .strictObject({
      textSize: z.int().min(9).max(24).optional(),
      frozenColumns: z.int().min(0).max(32).optional(),
    })
    .optional(),
})
export type ModuleTableWorkbook = z.infer<typeof ModuleTableWorkbookSchema>

export function moduleTableViewState(
  workbook: ModuleTableWorkbook,
  settings: Record<string, unknown>,
): ModuleTableViewState {
  return ModuleTableViewStateSchema.parse(
    settings[workbook.stateKey] ?? { version: 1, ...workbook.defaults },
  )
}

/** Never show a result from a different row draft, reference catalog or project setting. */
export function moduleTableComputedRows(data: {
  table: ModulePageTable
  rows: ModuleTableRow[]
  settings?: ModuleValues
  computed?: unknown
}): ModuleTableRow[] {
  if (!data.table.computed || !data.computed || typeof data.computed !== 'object') return []
  const snapshot = data.computed as { settings?: ModuleValues; rows?: unknown }
  if (!snapshot.settings || !data.settings) return []
  const other = (settings: ModuleValues) =>
    Object.fromEntries(Object.entries(settings).filter(([key]) => key !== data.table.id))
  if (JSON.stringify(other(snapshot.settings)) !== JSON.stringify(other(data.settings))) return []
  const inputs = ModuleTableRowsSchema.safeParse(snapshot.settings[data.table.id] ?? [])
  const results = ModuleTableRowsSchema.safeParse(snapshot.rows)
  if (!inputs.success || !results.success) return []
  return results.data.filter((result) => {
    const current = data.rows.find((row) => row.id === result.id)
    const original = inputs.data.find((row) => row.id === result.id)
    return current && original && JSON.stringify(current.values) === JSON.stringify(original.values)
  })
}
