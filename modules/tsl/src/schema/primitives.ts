import { z } from 'zod'

export const ActionColumnIdSchema = z.uuid().brand<'ActionColumnId'>()

export const ConnectionIdSchema = z.uuid().brand<'ConnectionId'>()

export const RgbHexSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/u)
  .transform((value) => value.toUpperCase())
  .brand<'RgbHex'>()

export const SafeIdentifierSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u)
