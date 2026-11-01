import { z } from 'zod'

export const BUTTON_NUMBER_MIN = 1

export const BUTTON_NUMBER_MAX = 999_999

const codePointLength = (value: string): number => Array.from(value).length

const BUTTON_IDENTIFIER_MAX_CODE_POINTS = 128

const BUTTON_IDENTIFIER_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u

function legacyButtonIdentifierInput(input: unknown): unknown {
  if (typeof input !== 'number') return input
  return Number.isSafeInteger(input) && input >= BUTTON_NUMBER_MIN && input <= BUTTON_NUMBER_MAX
    ? String(input)
    : input
}

export const ButtonIdentifierSchema = z.preprocess(
  legacyButtonIdentifierInput,
  z
    .string()
    .refine((value) => !BUTTON_IDENTIFIER_CONTROL_CHARACTERS.test(value), {
      message: 'button ID must not contain control or newline characters',
    })
    .transform((value) => value.trim())
    .refine(
      (value) =>
        codePointLength(value) >= 1 &&
        codePointLength(value) <= BUTTON_IDENTIFIER_MAX_CODE_POINTS,
      `button ID must contain 1..${String(BUTTON_IDENTIFIER_MAX_CODE_POINTS)} Unicode characters`,
    )
    .brand<'ButtonIdentifier'>(),
)

export const SafeIdentifierSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u)

export const SafeOperatorMessageSchema = z
  .string()
  .refine(
    (value) =>
      codePointLength(value) >= 1 &&
      codePointLength(value) <= 256 &&
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value),
    'operator message must be 1..256 readable Unicode characters',
  )
