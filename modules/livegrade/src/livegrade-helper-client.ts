import { z } from 'zod'
import { LiveGradeSlotCatalogEntrySchema, LiveGradeSlotCatalogSchema } from './config.js'

const MAX_HELPER_OUTPUT_BYTES = 256 * 1_024
const PROCESS_GRACE_MS = 750

const SafeHelperTextSchema = z
  .string()
  .max(512)
  .refine((value) => !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value))

export const LiveGradeHelperSlotSchema = LiveGradeSlotCatalogEntrySchema

export const LiveGradeHelperResponseSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    phase: z.enum(['ready', 'not-running', 'permission-required', 'menu-unavailable', 'error']),
    applicationVersion: SafeHelperTextSchema.nullable().default(null),
    slots: LiveGradeSlotCatalogSchema,
    selected: LiveGradeHelperSlotSchema.nullable().default(null),
    focusViolation: z.boolean(),
    errorCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,127}$/u)
      .nullable()
      .default(null),
    message: SafeHelperTextSchema.nullable().default(null),
  })
  .superRefine((response, context) => {
    if (
      response.selected !== null &&
      !response.slots.some(
        (slot) =>
          slot.position === response.selected?.position &&
          slot.menuTitle === response.selected.menuTitle,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selected'],
        message: 'the selected LiveGrade slot must be present in the returned catalog',
        input: response.selected,
      })
    }
    if (response.focusViolation !== (response.errorCode === 'livegrade_focus_violation')) {
      context.addIssue({
        code: 'custom',
        path: ['focusViolation'],
        message: 'LiveGrade focus violation state is inconsistent',
        input: response.focusViolation,
      })
    }
    if (response.phase === 'ready' && response.errorCode !== null) {
      context.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'a ready LiveGrade helper response cannot contain an error',
        input: response.errorCode,
      })
    }
    if (
      response.phase !== 'ready' &&
      (response.errorCode === null || response.message === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'a non-ready LiveGrade helper response requires a bounded error',
        input: response,
      })
    }
  })
  .readonly()

export type LiveGradeHelperResponse = z.infer<typeof LiveGradeHelperResponseSchema>

export type LiveGradeHelperClientErrorCode =
  | 'helper_timeout'
  | 'helper_launch_failed'
  | 'helper_failed'
  | 'helper_invalid_response'

export class LiveGradeHelperClientError extends Error {
  override readonly name = 'LiveGradeHelperClientError'

  constructor(
    readonly code: LiveGradeHelperClientErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface LiveGradeHelperInvocation {
  readonly executablePath: string
  readonly arguments: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export type LiveGradeHelperRunner = (
  invocation: LiveGradeHelperInvocation,
) => Promise<{ readonly stdout: string }>

export interface LiveGradeHelperClientContract {
  probe(timeoutMs: number): Promise<LiveGradeHelperResponse>
  requestAccessibilityPermission(timeoutMs: number): Promise<LiveGradeHelperResponse>
  selectSlot(input: {
    readonly position: number
    readonly timeoutMs: number
  }): Promise<LiveGradeHelperResponse>
}
