import { z } from "zod";
import { ModuleFieldsSchema } from "./fields.js";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u);
const Label = z.string().trim().min(1).max(160);

/** Transient page inputs and explicit commands, never workbook actions or saved settings. */
export const ModulePageControlsSchema = z
  .strictObject({
    type: z.literal("controls"),
    id: Id,
    label: Label,
    fields: ModuleFieldsSchema,
    commands: z
      .array(
        z.strictObject({
          id: Id,
          label: Label,
          kind: z.enum(["command", "copy", "download"]),
          inputFields: z.array(Id).max(32),
          enabledWhen: Id.optional(),
        }),
      )
      .min(1)
      .max(16),
  })
  .superRefine((section, ctx) => {
    if (
      new Set(section.commands.map((item) => item.id)).size !==
      section.commands.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate page command ID" });
    const fields = new Set(section.fields.map((field) => field.id));
    for (const command of section.commands)
      if (
        new Set(command.inputFields).size !== command.inputFields.length ||
        command.inputFields.some((id) => !fields.has(id))
      )
        ctx.addIssue({
          code: "custom",
          message: "Page commands must reference unique declared inputs",
        });
  });

/** Text is chunked so exports never exceed the bounded worker IPC envelope. */
export const ModulePageCommandResultSchema = z.strictObject({
  message: z.string().max(1000).optional(),
  text: z.string().max(65_536).optional(),
  nextCursor: z.string().min(1).max(1024).nullable().optional(),
  fileName: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u)
    .optional(),
});

export type ModulePageControls = z.infer<typeof ModulePageControlsSchema>;
export type ModulePageCommandResult = z.infer<
  typeof ModulePageCommandResultSchema
>;
