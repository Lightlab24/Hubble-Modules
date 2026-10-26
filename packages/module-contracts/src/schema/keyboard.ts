import { z } from 'zod'

export const KEYBOARD_KEYS = [
  ...Array.from({ length: 26 }, (_, index) => `Key${String.fromCharCode(65 + index)}`),
  ...Array.from({ length: 10 }, (_, index) => `Digit${String(index)}`),
  ...Array.from({ length: 20 }, (_, index) => `F${String(index + 1)}`),
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
] as const

export const KeyboardKeySchema = z.enum(KEYBOARD_KEYS)

export const KeyboardModifierSchema = z.enum(['command', 'control', 'option', 'shift'])

export const KeyboardBundleIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/u)

export const SystemMenuPathSchema = z
  .array(
    z
      .strictObject({
        title: z
          .string()
          .min(1)
          .max(256)
          .refine(
            (value) => !/[\u0000-\u001f\u007f]/u.test(value),
            'Menu titles must be readable',
          ),
        identifier: z.string().min(1).max(256).optional(),
      })
      .readonly(),
  )
  .min(2)
  .max(12)
  .readonly()
