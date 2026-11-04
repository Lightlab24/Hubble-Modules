import { z } from "zod";
import {
  ModuleChoiceSchema,
  moduleFieldVisible,
  validateModuleFields,
  type ModuleField,
} from "./fields.js";
import type { ModulePageTable, ModuleValues } from "./index.js";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u);
export const ModuleFieldAvailabilitySchema = z.enum([
  "editable",
  "read-only",
  "unavailable",
]);
export const ModuleWorkbookFieldRuleSchema = z.strictObject({
  id: Id,
  dependencies: z.array(Id).min(1).max(32),
  when: z
    .array(
      z.strictObject({
        field: Id,
        equals: z.union([
          z.string().max(1024),
          z.number(),
          z.boolean(),
          z.null(),
        ]),
        negate: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(32),
  fields: z
    .record(
      Id,
      z.strictObject({
        availability: ModuleFieldAvailabilitySchema.optional(),
        blank: z.boolean().optional(),
        default: z
          .union([z.string().max(16384), z.number(), z.boolean(), z.null()])
          .optional(),
        editor: z.enum(["text", "color"]).optional(),
        choices: z.array(ModuleChoiceSchema).max(1024).optional(),
        min: z.number().optional(),
        max: z.number().optional(),
      }),
    )
    .refine(
      (fields) =>
        Object.keys(fields).length > 0 && Object.keys(fields).length <= 32,
    ),
});
export type ModuleFieldAvailability = z.infer<
  typeof ModuleFieldAvailabilitySchema
>;
export type ModuleWorkbookFieldRule = z.infer<
  typeof ModuleWorkbookFieldRuleSchema
>;

/** Pure draft projection, shared by the host grid, validation and package backends.
 * Matching rules apply in declaration order. Computed/hidden fields cannot be made editable.
 */
export function moduleWorkbookField(
  table: ModulePageTable,
  values: ModuleValues,
  original: ModuleField,
) {
  const effective = {
    ...Object.fromEntries(
      table.columns.map((field) => [field.id, field.default]),
    ),
    ...values,
  };
  let field = original;
  let availability: ModuleFieldAvailability =
    table.source === "state" || table.computed?.columns.includes(field.id)
      ? "read-only"
      : "editable";
  let blank = false;
  let editor = table.workbook?.columns?.[field.id]?.editor;
  for (const rule of table.fieldRules ?? []) {
    if (
      !rule.when.every(
        (condition) =>
          (effective[condition.field] === condition.equals) !==
          (condition.negate === true),
      )
    )
      continue;
    const change = rule.fields[field.id];
    if (!change) continue;
    availability = change.availability ?? availability;
    blank = change.blank ?? blank;
    editor = change.editor ?? editor;
    if (
      change.default !== undefined &&
      (field.type === "text" || field.type === "choice") &&
      typeof change.default === "string"
    )
      field = { ...field, default: change.default };
    if (
      change.default !== undefined &&
      field.type === "number" &&
      (typeof change.default === "number" || change.default === null)
    )
      field = { ...field, default: change.default };
    if (field.type === "boolean" && typeof change.default === "boolean")
      field = { ...field, default: change.default };
    if (field.type === "number")
      field = {
        ...field,
        ...(change.min !== undefined ? { min: change.min } : {}),
        ...(change.max !== undefined ? { max: change.max } : {}),
      };
    if (field.type === "choice" && change.choices)
      field = { ...field, choices: change.choices, choiceProvider: undefined };
  }
  if (!moduleFieldVisible(original, effective)) {
    availability = "unavailable";
    blank = true;
  }
  if (
    (table.source === "state" || table.computed?.columns.includes(field.id)) &&
    availability === "editable"
  )
    availability = "read-only";
  return {
    field,
    availability,
    blank: availability === "unavailable" && blank,
    editor,
  };
}

export function moduleWorkbookApplicableFields(
  table: ModulePageTable,
  values: ModuleValues,
): string[] {
  return table.columns
    .filter(
      (field) =>
        !table.computed?.columns.includes(field.id) &&
        moduleWorkbookField(table, values, field).availability !==
          "unavailable",
    )
    .map((field) => field.id);
}

export function validateModuleWorkbookRow(
  table: ModulePageTable,
  values: ModuleValues,
): void {
  const fields = table.columns
    .filter((field) => !table.computed?.columns.includes(field.id))
    .flatMap((field) => {
      const resolved = moduleWorkbookField(table, values, field);
      return resolved.availability === "unavailable" ? [] : [resolved.field];
    });
  validateModuleFields(fields, values);
}

/** Dependency-first input application makes rectangular paste independent of visible column order. */
export function moduleWorkbookEditOrder(table: ModulePageTable): string[] {
  const dependencies = new Map<string, Set<string>>();
  for (const rule of table.fieldRules ?? [])
    for (const field of Object.keys(rule.fields)) {
      const set = dependencies.get(field) ?? new Set<string>();
      for (const id of rule.dependencies) set.add(id);
      dependencies.set(field, set);
    }
  for (const [id, parents] of Object.entries(table.choiceDependencies ?? {})) {
    const set = dependencies.get(id) ?? new Set<string>();
    for (const parent of parents) set.add(parent);
    dependencies.set(id, set);
  }
  const ordered: string[] = [],
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (ordered.includes(id)) return;
    if (visiting.has(id))
      throw new Error("Workbook field dependencies must be acyclic");
    visiting.add(id);
    for (const parent of dependencies.get(id) ?? []) visit(parent);
    visiting.delete(id);
    ordered.push(id);
  };
  for (const field of table.columns) visit(field.id);
  return ordered;
}
