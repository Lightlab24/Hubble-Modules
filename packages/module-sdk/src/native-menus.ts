import { z } from 'zod'

// AX menu titles may contain a tab before a displayed shortcut. Preserve that
// source for exact invocation; packages own presentation and domain interpretation.
const MenuText = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 256 &&
      !/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
  )
const Identifier = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      new TextEncoder().encode(value).length <= 256 &&
      !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
  )
export const NativeMenuSegmentSchema = z.strictObject({
  title: MenuText,
  identifier: Identifier.optional(),
})
export const NativeMenuPathSchema = z.array(NativeMenuSegmentSchema).min(1).max(12)
export const NativeApplicationTargetSchema = z.strictObject({
  bundleId: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u),
  /** Optional actual executable basename. Resolving multiple matching processes is an error. */
  executableName: Identifier.refine(
    (value) => !value.includes('/') && !value.includes('\\'),
  ).optional(),
})
const Cursor = z
  .string()
  .max(41)
  .regex(
    /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}:(?:[1-9]\d{0,2}|[1-7]\d{3}|8000)$/u,
  )
export const NativeMenuRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({
    method: z.literal('read'),
    target: NativeApplicationTargetSchema,
    path: NativeMenuPathSchema,
    cursor: Cursor.optional(),
  }),
  z.strictObject({
    method: z.literal('select'),
    target: NativeApplicationTargetSchema,
    path: NativeMenuPathSchema.min(2),
    preserveBackgroundFocus: z.boolean().default(true),
    expectedProcessId: z.int().positive().max(2147483647).optional(),
  }),
])
export const NativeMenuResponseSchema = z
  .strictObject({
    available: z.boolean(),
    permissionGranted: z.boolean(),
    application: z
      .strictObject({
        bundleId: NativeApplicationTargetSchema.shape.bundleId,
        executableName: Identifier.nullable(),
        version: Identifier.nullable(),
        pid: z.int().positive(),
      })
      .nullable()
      .default(null),
    items: z
      .array(z.strictObject({ path: NativeMenuPathSchema.min(2), enabled: z.boolean() }))
      .max(1000)
      .default([]),
    nextCursor: Cursor.nullable().default(null),
    truncated: z.boolean().default(false),
    completed: z.boolean().default(false),
    focusViolation: z.boolean().default(false),
    errorCode: z
      .enum([
        'native_unavailable',
        'native_permission_required',
        'native_application_not_running',
        'native_application_ambiguous',
        'native_application_changed',
        'native_menu_unavailable',
        'native_menu_not_found',
        'native_menu_ambiguous',
        'native_menu_disabled',
        'native_menu_failed',
        'native_focus_changed',
      ])
      .nullable(),
    message: z.string().max(512).nullable(),
  })
  .superRefine((value, context) => {
    if (
      value.completed &&
      (!value.available ||
        !value.permissionGranted ||
        value.errorCode !== null ||
        value.focusViolation)
    )
      context.addIssue({
        code: 'custom',
        message: 'Native completion requires authorized response evidence without an error',
      })
    if (value.focusViolation !== (value.errorCode === 'native_focus_changed'))
      context.addIssue({ code: 'custom', message: 'Native focus evidence and error must agree' })
  })
export type NativeMenuRequest = z.infer<typeof NativeMenuRequestSchema>
export type NativeMenuResponse = z.infer<typeof NativeMenuResponseSchema>
export type NativeMenuProvider = (request: NativeMenuRequest) => Promise<NativeMenuResponse>
