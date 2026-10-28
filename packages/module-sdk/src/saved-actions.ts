import { z } from 'zod'

/** Source expressions only. Evaluation caches and unrelated workbook data never enter a module. */
export const ModuleSavedExpressionSchema = z.strictObject({
  mode: z.enum(['literal', 'formula']),
  source: z.string().refine((source) => Array.from(source).length <= 4096),
})
export const ModuleSavedActionSchema = z.strictObject({
  key: z.string().min(1).max(192),
  actionId: ModuleSavedExpressionSchema,
  actionFields: ModuleSavedExpressionSchema,
  feedback: ModuleSavedExpressionSchema,
})
export const ModuleSavedActionsSchema = z
  .array(ModuleSavedActionSchema)
  .max(8192)
  .refine(
    (items) => new Set(items.map((item) => item.key)).size === items.length,
    'Duplicate saved action key',
  )
export type ModuleSavedAction = z.infer<typeof ModuleSavedActionSchema>
export type ModuleSavedActions = z.infer<typeof ModuleSavedActionsSchema>
export const ModuleSavedActionMigrationSchema = z
  .strictObject({
    before: ModuleSavedActionsSchema,
    after: ModuleSavedActionsSchema,
  })
  .refine(
    ({ before, after }) =>
      before.length === after.length &&
      before.every((item, index) => item.key === after[index]?.key),
    'Migration must preserve every binding identity and its order',
  )
export type ModuleSavedActionMigration = z.infer<typeof ModuleSavedActionMigrationSchema>
