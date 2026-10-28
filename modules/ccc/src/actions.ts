import { z } from "zod";
import { CCC_COMMAND_OPTIONS, CccActionSchema } from "./schema/ccc.js";

/** This module owns its supported action IDs and validation. */
export const actionSchemas = {
  "ccc.command": CccActionSchema,
  ...Object.fromEntries(
    CCC_COMMAND_OPTIONS.map(({ value }) => [
      value,
      z.strictObject({ type: z.literal(value), cameraId: z.uuid().optional() }),
    ]),
  ),
  "record-rcp": z.strictObject({
    type: z.literal("record-rcp"),
    connectionId: z.uuid(),
    command: z.enum([
      "record-camera",
      "record-group-all",
      "start-enabled-cameras",
      "stop-enabled-cameras",
    ]),
    cameraNumber: z.int().min(1).max(999999).optional(),
  }),
} as const;
export const ActionDefinitionSchema = CccActionSchema;
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
