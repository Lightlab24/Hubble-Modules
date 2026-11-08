import { z } from "zod";
import type { ModuleJsonValue, ModuleValues } from "./index.js";
import {
  MODULE_TIMECODE_FRAME_RATES,
  moduleTimecodeIssue,
} from "./timecode.js";
export * from "./timecode.js";

const Identifier = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
export const ModuleShortcutEditorSchema = z.strictObject({
  modifiersField: Identifier,
});
/** Draws a number field as Hubble's shared slider. Steps below 1e-6 cannot snap reliably. */
export const ModuleFieldSliderSchema = z.strictObject({
  step: z.number().min(0.000001),
  /** Printed directly after the value, so include any space: "%" or " dB". */
  unit: z.string().max(16).optional(),
});
/** Draws a boolean field as Hubble's On/Off switch. Requires module-controls-v1. */
export const ModuleFieldSwitchSchema = z.strictObject({
  onLabel: z.string().trim().min(1).max(16).optional(),
  offLabel: z.string().trim().min(1).max(16).optional(),
});
/** Draws a choice field as a row of buttons. Requires module-controls-v1. */
export const ModuleFieldSegmentedSchema = z.strictObject({});
/** Draws a number field with − and + buttons. Requires module-controls-v1. */
export const ModuleFieldStepperSchema = z.strictObject({
  step: z.number().min(0.000001),
});
/** Checks a text field as HH:MM:SS:FF timecode. Requires module-controls-v1. */
export const ModuleFieldTimecodeSchema = z.strictObject({
  frameRate: z.enum(MODULE_TIMECODE_FRAME_RATES),
});
const Label = z.string().trim().min(1).max(160);
export const ModuleChoiceSchema = z.strictObject({
  id: z.string().max(160),
  label: z.string().max(160),
  group: Label.optional(),
  /** Optional atomic values for a Matrix choice. Only declared choiceFields may be changed. */
  values: z
    .record(
      Identifier,
      z.union([z.string().max(4096), z.number(), z.boolean(), z.null()]),
    )
    .refine((values) => Object.keys(values).length <= 16)
    .optional(),
});
export type ModuleChoice = z.infer<typeof ModuleChoiceSchema>;
export type ModuleChoiceValues = NonNullable<ModuleChoice["values"]>;
const Condition = z.strictObject({
  field: Identifier,
  equals: z.union([z.string().max(1024), z.number(), z.boolean(), z.null()]),
  negate: z.boolean().optional(),
});
const Validation = z.strictObject({
  message: z.string().min(1).max(1000),
  minLength: z.int().min(0).max(16_384).optional(),
  maxLength: z.int().min(0).max(16_384).optional(),
});
const Base = {
  id: Identifier,
  label: Label,
  required: z.boolean(),
  description: z.string().trim().min(1).max(1000).optional(),
  visibleWhen: z.array(Condition).min(1).max(16).optional(),
  validation: Validation.optional(),
  shortcut: ModuleShortcutEditorSchema.optional(),
};
type BaseField = {
  id: string;
  label: string;
  required: boolean;
  description?: string | undefined;
  visibleWhen?: z.infer<typeof Condition>[] | undefined;
  validation?: z.infer<typeof Validation> | undefined;
  shortcut?: z.infer<typeof ModuleShortcutEditorSchema> | undefined;
};
type Choices = { choices: ModuleChoice[]; choiceProvider?: string | undefined };
export type ModuleField = BaseField &
  (
    | {
        type: "text";
        default: string;
        secret?: boolean | undefined;
        timecode?: z.infer<typeof ModuleFieldTimecodeSchema> | undefined;
      }
    | {
        type: "number";
        default: number | null;
        min?: number | undefined;
        max?: number | undefined;
        integer?: boolean | undefined;
        slider?: z.infer<typeof ModuleFieldSliderSchema> | undefined;
        stepper?: z.infer<typeof ModuleFieldStepperSchema> | undefined;
      }
    | {
        type: "boolean";
        default: boolean;
        switch?: z.infer<typeof ModuleFieldSwitchSchema> | undefined;
      }
    | ({
        type: "choice";
        default: string;
        segmented?: z.infer<typeof ModuleFieldSegmentedSchema> | undefined;
      } & Choices)
    | ({
        type: "multi-choice";
        default: string[];
        minItems?: number | undefined;
        maxItems?: number | undefined;
      } & Choices)
    | {
        type: "object";
        default: Record<string, ModuleJsonValue>;
        fields: ModuleField[];
      }
    | {
        type: "array";
        default: ModuleJsonValue[];
        item: ModuleField;
        minItems?: number | undefined;
        maxItems: number;
      }
  );
const ChoiceFields = {
  choices: z
    .array(
      ModuleChoiceSchema.extend({
        id: z.string().min(1).max(160),
        label: Label,
      }),
    )
    .max(1024),
  choiceProvider: Identifier.optional(),
};
function fieldSchema(depth: number): z.ZodType<ModuleField> {
  return z.lazy(() =>
    z.discriminatedUnion("type", [
      z.strictObject({
        ...Base,
        type: z.literal("text"),
        default: z.string().max(16_384),
        secret: z.boolean().optional(),
        timecode: ModuleFieldTimecodeSchema.optional(),
      }),
      z.strictObject({
        ...Base,
        type: z.literal("number"),
        default: z.number().nullable(),
        min: z.number().optional(),
        max: z.number().optional(),
        integer: z.boolean().optional(),
        slider: ModuleFieldSliderSchema.optional(),
        stepper: ModuleFieldStepperSchema.optional(),
      }),
      z.strictObject({
        ...Base,
        type: z.literal("boolean"),
        default: z.boolean(),
        switch: ModuleFieldSwitchSchema.optional(),
      }),
      z.strictObject({
        ...Base,
        type: z.literal("choice"),
        default: z.string().max(160),
        segmented: ModuleFieldSegmentedSchema.optional(),
        ...ChoiceFields,
      }),
      z.strictObject({
        ...Base,
        type: z.literal("multi-choice"),
        default: z.array(z.string().max(160)).max(128),
        ...ChoiceFields,
        minItems: z.int().min(0).max(128).optional(),
        maxItems: z.int().min(1).max(128).optional(),
      }),
      z.strictObject({
        ...Base,
        type: z.literal("object"),
        default: z.record(Identifier, z.json()),
        fields: z.array(depth < 4 ? fieldSchema(depth + 1) : z.never()).max(32),
      }),
      z.strictObject({
        ...Base,
        type: z.literal("array"),
        default: z.array(z.json()).max(128),
        item: depth < 4 ? fieldSchema(depth + 1) : z.never(),
        minItems: z.int().min(0).max(128).optional(),
        maxItems: z.int().min(1).max(128),
      }),
    ]),
  );
}
export const ModuleFieldSchema = fieldSchema(0);
export const ModuleFieldsSchema = z
  .array(ModuleFieldSchema)
  .max(128)
  .superRefine((fields, ctx) => {
    let total = 0;
    const visit = (
      items: ModuleField[],
      depth: number,
      path: (string | number)[],
    ) => {
      if (depth > 4 || (total += items.length) > 512) {
        ctx.addIssue({
          code: "custom",
          path,
          message: "Module fields exceed nesting or count limit",
        });
        return;
      }
      const ids = new Set(items.map((field) => field.id));
      if (ids.size !== items.length)
        ctx.addIssue({ code: "custom", path, message: "Duplicate field ID" });
      items.forEach((field, index) => {
        const at = [...path, index];
        const problem = (message: string) => {
          ctx.addIssue({ code: "custom", path: at, message });
        };
        if (
          field.shortcut &&
          (!["text", "choice"].includes(field.type) ||
            (field.type === "text" && field.secret) ||
            field.id === field.shortcut.modifiersField ||
            !items.some(
              (other) =>
                other.id === field.shortcut?.modifiersField &&
                other.type === "text" &&
                !other.shortcut &&
                !other.secret,
            ) ||
            items.filter(
              (other) =>
                other.shortcut?.modifiersField ===
                field.shortcut?.modifiersField,
            ).length !== 1)
        )
          problem(
            "Shortcut editor requires a unique sibling text modifiers field",
          );
        if (
          field.visibleWhen?.some(
            (rule) => !ids.has(rule.field) || rule.field === field.id,
          )
        )
          problem("Visibility must reference a sibling field");
        if (
          field.validation &&
          (field.validation.minLength ?? 0) >
            (field.validation.maxLength ?? 16_384)
        )
          problem("Validation bounds conflict");
        if (
          field.type === "number" &&
          field.default !== null &&
          ((field.min !== undefined && field.default < field.min) ||
            (field.max !== undefined && field.default > field.max) ||
            (field.integer && !Number.isInteger(field.default)))
        )
          problem("Number default/bounds conflict");
        if (field.type === "number" && field.default === null && field.required)
          problem("Empty numeric defaults require an optional field");
        if (field.type === "number" && field.slider) {
          const issue = moduleSliderFieldIssue(field, field.slider);
          if (issue) problem(issue);
        }
        if (field.type === "number" && field.stepper) {
          const issue = moduleStepperFieldIssue(field, field.stepper);
          if (issue) problem(issue);
        }
        if (
          field.type === "choice" &&
          field.segmented &&
          (field.choiceProvider !== undefined ||
            field.choices.length < 2 ||
            field.choices.length > 8)
        )
          problem("Segmented choices need 2 to 8 static choices");
        if (field.type === "text" && field.timecode) {
          if (field.secret || field.shortcut)
            problem("Timecode fields cannot be secret shortcuts");
          else if (
            (field.default !== "" || field.required) &&
            moduleTimecodeIssue(field.default, field.timecode.frameRate)
          )
            problem("Timecode default must be valid timecode");
        }
        if (field.type === "choice" || field.type === "multi-choice") {
          const choices = new Set(field.choices.map((choice) => choice.id));
          if (choices.size !== field.choices.length)
            problem("Duplicate choice ID");
          const defaults =
            field.type === "choice" ? [field.default] : field.default;
          if (
            !field.choiceProvider &&
            defaults.some((value) => !choices.has(value))
          )
            problem("Choice default is missing");
        }
        if (
          (field.type === "array" || field.type === "multi-choice") &&
          ((field.minItems ?? 0) > (field.maxItems ?? 128) ||
            field.default.length > (field.maxItems ?? 128))
        )
          problem("Collection default/bounds conflict");
        if (
          field.validation &&
          field.type !== "text" &&
          field.type !== "choice" &&
          (field.validation.minLength !== undefined ||
            field.validation.maxLength !== undefined)
        )
          problem("Length validation requires a text or choice field");
        if (field.type === "object")
          visit(field.fields, depth + 1, [...at, "fields"]);
        if (field.type === "array") {
          visit([field.item], depth + 1, [...at, "item"]);
          try {
            validateModuleFields([field.item], {
              [field.item.id]: moduleFieldDefault(field.item),
            });
          } catch {
            problem("Array items need valid defaults for immediate creation");
          }
        }
      });
    };
    visit(fields, 0, []);
  });
/** Allow for binary rounding, as in (200 - 10) / 0.1 = 1900.0000000000002. */
function onSliderGrid(value: number, min: number, step: number): boolean {
  const steps = (value - min) / step;
  return (
    Math.abs(steps - Math.round(steps)) <= 1e-9 * Math.max(1, Math.abs(steps))
  );
}
function moduleSliderFieldIssue(
  field: Extract<ModuleField, { type: "number" }>,
  slider: z.infer<typeof ModuleFieldSliderSchema>,
): string | undefined {
  const { min, max, default: initial } = field;
  if (min === undefined || max === undefined || min >= max)
    return "Slider fields need a min below their max";
  if (initial === null) return "Slider fields need a numeric default";
  if (
    field.integer &&
    !(Number.isInteger(min) && Number.isInteger(slider.step))
  )
    return "Integer sliders need a whole number min and step";
  // A slider only stops on min + n * step, so a max or default between stops is unreachable.
  if (
    !onSliderGrid(max, min, slider.step) ||
    !onSliderGrid(initial, min, slider.step)
  )
    return "Slider max and default must be whole steps from min";
  return undefined;
}
function moduleStepperFieldIssue(
  field: Extract<ModuleField, { type: "number" }>,
  stepper: z.infer<typeof ModuleFieldStepperSchema>,
): string | undefined {
  if (field.slider)
    return "A number field cannot be both a slider and a stepper";
  const { min, max, default: initial } = field;
  if (min === undefined || max === undefined || min >= max)
    return "Stepper fields need a min below their max";
  if (initial === null) return "Stepper fields need a numeric default";
  if (
    field.integer &&
    !(Number.isInteger(min) && Number.isInteger(stepper.step))
  )
    return "Integer steppers need a whole number min and step";
  if (!onSliderGrid(initial, min, stepper.step))
    return "Stepper default must be whole steps from min";
  return undefined;
}
/** Fields drawn by module-controls-v1: switch, segmented, stepper or timecode. */
export function moduleFieldsUseControls(
  fields: readonly ModuleField[],
): boolean {
  return fields.some((field) =>
    field.type === "object"
      ? moduleFieldsUseControls(field.fields)
      : field.type === "array"
        ? moduleFieldsUseControls([field.item])
        : (field.type === "boolean" && field.switch !== undefined) ||
          (field.type === "choice" && field.segmented !== undefined) ||
          (field.type === "number" && field.stepper !== undefined) ||
          (field.type === "text" && field.timecode !== undefined),
  );
}
export function moduleFieldsUseSliders(
  fields: readonly ModuleField[],
): boolean {
  return fields.some((field) =>
    field.type === "number"
      ? field.slider !== undefined
      : field.type === "object"
        ? moduleFieldsUseSliders(field.fields)
        : field.type === "array"
          ? moduleFieldsUseSliders([field.item])
          : false,
  );
}
export function moduleFieldVisible(
  field: ModuleField,
  values: ModuleValues,
): boolean {
  return (
    field.visibleWhen?.every(
      (rule) => (values[rule.field] === rule.equals) !== (rule.negate === true),
    ) ?? true
  );
}
export function moduleFieldsRequireV2(fields: readonly ModuleField[]): boolean {
  return fields.some(
    (field) =>
      field.visibleWhen !== undefined ||
      field.validation !== undefined ||
      field.type === "object" ||
      field.type === "array" ||
      field.type === "multi-choice" ||
      (field.type === "number" && field.integer !== undefined),
  );
}
export function moduleFieldsAllowEmptyNumbers(
  fields: readonly ModuleField[],
): boolean {
  return fields.some((field) =>
    field.type === "number"
      ? field.default === null
      : field.type === "object"
        ? moduleFieldsAllowEmptyNumbers(field.fields)
        : field.type === "array"
          ? moduleFieldsAllowEmptyNumbers([field.item])
          : false,
  );
}
export function moduleChoiceProviders(
  fields: readonly ModuleField[],
): string[] {
  return [
    ...new Set(
      fields.flatMap((field): string[] =>
        field.type === "object"
          ? moduleChoiceProviders(field.fields)
          : field.type === "array"
            ? moduleChoiceProviders([field.item])
            : (field.type === "choice" || field.type === "multi-choice") &&
                field.choiceProvider
              ? [field.choiceProvider]
              : [],
      ),
    ),
  ];
}
type MutableJson =
  | string
  | number
  | boolean
  | null
  | MutableJson[]
  | { [key: string]: MutableJson };
export function moduleFieldDefault(field: ModuleField): MutableJson {
  return structuredClone(
    field.type === "object"
      ? {
          ...Object.fromEntries(
            field.fields.map((child) => [child.id, moduleFieldDefault(child)]),
          ),
          ...field.default,
        }
      : field.default,
  ) as MutableJson;
}
export function validateModuleFields(
  fields: readonly ModuleField[],
  values: ModuleValues,
): void {
  const effective = {
    ...Object.fromEntries(
      fields.map((field) => [field.id, moduleFieldDefault(field)]),
    ),
    ...values,
  };
  for (const field of fields) {
    if (!moduleFieldVisible(field, effective)) continue;
    const value = values[field.id];
    const fail = (reason: string): never => {
      throw new Error(field.validation?.message ?? `${reason}: ${field.label}`);
    };
    if (value === undefined) {
      if (field.required) fail("Missing module field");
      continue;
    }
    if (
      value === null &&
      field.type === "number" &&
      field.default === null &&
      !field.required
    )
      continue;
    if (field.type === "boolean" && typeof value !== "boolean")
      fail("Expected a boolean");
    if (
      field.type === "number" &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max) ||
        (field.integer && !Number.isInteger(value)))
    )
      fail("Invalid number");
    if (
      field.type === "text" &&
      (typeof value !== "string" ||
        value.length > 16_384 ||
        (field.required && !value.trim()))
    )
      fail("Invalid text");
    if (
      field.type === "text" &&
      field.timecode &&
      typeof value === "string" &&
      (value !== "" || field.required)
    ) {
      const issue = moduleTimecodeIssue(value, field.timecode.frameRate);
      if (issue)
        throw new Error(
          field.validation?.message ?? `${issue}: ${field.label}`,
        );
    }
    if (
      field.type === "choice" &&
      (typeof value !== "string" ||
        value.length > 160 ||
        (!field.choiceProvider &&
          !field.choices.some((choice) => choice.id === value)))
    )
      fail("Invalid choice");
    if (field.type === "multi-choice") {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some(
          (item) =>
            typeof item !== "string" ||
            item.length > 160 ||
            (!field.choiceProvider &&
              !field.choices.some((choice) => choice.id === item)),
        )
      )
        fail("Invalid choices");
    }
    if (field.type === "multi-choice" || field.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length < (field.minItems ?? (field.required ? 1 : 0)) ||
        value.length > (field.maxItems ?? 128)
      )
        fail("Invalid collection size");
      if (field.type === "array" && Array.isArray(value))
        for (const item of value as readonly ModuleJsonValue[])
          validateModuleFields([field.item], { [field.item.id]: item });
    }
    if (field.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        fail("Expected an object");
      validateModuleFields(field.fields, value as ModuleValues);
    }
    if (
      field.validation &&
      (typeof value === "string" || Array.isArray(value)) &&
      (value.length < (field.validation.minLength ?? 0) ||
        value.length > (field.validation.maxLength ?? 16_384))
    )
      fail("Invalid length");
  }
}

export function moduleFieldsContainSecrets(
  fields: readonly ModuleField[],
): boolean {
  return fields.some((field) =>
    field.type === "text"
      ? Boolean(field.secret)
      : field.type === "object"
        ? moduleFieldsContainSecrets(field.fields)
        : field.type === "array"
          ? moduleFieldsContainSecrets([field.item])
          : false,
  );
}
export function moduleSecretValues(
  fields: readonly ModuleField[],
  values: ModuleValues,
): string[] {
  return fields.flatMap((field): string[] => {
    const value = values[field.id];
    if (
      field.type === "text" &&
      field.secret &&
      typeof value === "string" &&
      value.length
    )
      return [value];
    if (
      field.type === "object" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    )
      return moduleSecretValues(field.fields, value as ModuleValues);
    if (field.type === "array" && Array.isArray(value))
      return (value as readonly ModuleJsonValue[]).flatMap((item) =>
        moduleSecretValues([field.item], { [field.item.id]: item }),
      );
    return [];
  });
}
