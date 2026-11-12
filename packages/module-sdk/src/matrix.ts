import { z } from "zod";
import { ModuleFieldsSchema, ModuleShortcutEditorSchema } from "./fields.js";
import {
  ModuleOrderedNumbersSchema,
  ModuleColorPaletteSchema,
  parseModuleOrderedNumbers,
  parseModuleColorPalette,
} from "./collections.js";

const Id = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const Label = z.string().trim().min(1).max(160);
const Scalar = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.null(),
]);
const Color = z.string().regex(/^#[0-9a-f]{6}$/iu);

const ParameterConditions = z
  .array(
    z.strictObject({
      field: Id,
      values: z.array(Scalar).min(1).max(256),
      negate: z.boolean().optional(),
    }),
  )
  .max(16);

/** A choice can own a small parameter form without owning any renderer code. */
export const ModuleChoiceParameterSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: Id,
    label: Label,
    type: z.literal("boolean"),
    default: z.boolean(),
    enabledWhen: ParameterConditions.optional(),
  }),
  z.strictObject({
    id: Id,
    label: Label,
    type: z.literal("color-pair"),
    default: z.tuple([Color, Color]),
    labels: z.tuple([Label, Label]),
    enabledWhen: ParameterConditions.optional(),
  }),
]);
export const ModuleChoiceEditorSchema = z
  .strictObject({
    choices: z
      .array(
        z.strictObject({
          value: z
            .string()
            .max(160)
            .regex(/^[^;=]*$/u),
          label: Label,
          description: z.string().max(1000).optional(),
          parameters: z.array(ModuleChoiceParameterSchema).max(16).default([]),
          /** Old spellings are decoded without rewriting untouched source expressions. */
          aliases: z
            .array(
              z.strictObject({
                value: z.string().min(1).max(160),
                parameters: z.record(Id, z.json()),
              }),
            )
            .max(32)
            .optional(),
          preserveParameters: z.boolean().optional(),
          hidden: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(256),
  })
  .superRefine(({ choices }, ctx) => {
    const values = choices.flatMap((choice) => [
      choice.value,
      ...(choice.aliases ?? []).map((alias) => alias.value),
    ]);
    if (new Set(values).size !== values.length)
      ctx.addIssue({
        code: "custom",
        message: "Choice values and aliases must be unique",
      });
    for (const choice of choices)
      if (
        new Set(choice.parameters.map((field) => field.id)).size !==
        choice.parameters.length
      )
        ctx.addIssue({
          code: "custom",
          message: "Choice parameter IDs must be unique",
        });
  });
export type ModuleChoiceEditor = z.infer<typeof ModuleChoiceEditorSchema>;
export type ModuleChoiceValue = {
  value: string;
  parameters: Record<string, unknown>;
  explicit: boolean;
};

/** API 1 source codec. No protocol names, module IDs or device rules belong here. */
export function decodeModuleChoice(
  editor: ModuleChoiceEditor,
  source: string,
): ModuleChoiceValue | null {
  const [name, ...parts] = source.split(";");
  const choice = editor.choices.find(
    (item) =>
      item.value === name ||
      item.aliases?.some((alias) => alias.value === name),
  );
  if (!choice || source.length > 4096) return null;
  const alias = choice.aliases?.find((item) => item.value === name);
  const parameters: Record<string, unknown> = Object.fromEntries(
    choice.parameters.map((field) => [
      field.id,
      structuredClone(field.default),
    ]),
  );
  Object.assign(parameters, alias?.parameters);
  const seen = new Set<string>();
  for (const part of parts) {
    const split = part.indexOf("=");
    if (split < 1) return null;
    const key = part.slice(0, split),
      value = part.slice(split + 1);
    if (seen.has(key)) return null;
    seen.add(key);
    const field = choice.parameters.find((item) => item.id === key);
    // Preserve legacy parameterized choices whose form is intentionally hidden.
    if (!field) {
      if (!choice.preserveParameters || !Id.safeParse(key).success) return null;
      parameters[key] = value;
    } else if (field.type === "boolean") {
      if (value !== "on" && value !== "off") return null;
      parameters[key] = value === "on";
    } else {
      const colors = z.tuple([Color, Color]).safeParse(value.split("|"));
      if (!colors.success) return null;
      parameters[key] = colors.data;
    }
  }
  return {
    value: choice.value,
    parameters,
    explicit: parts.length > 0 || !!alias,
  };
}

export function encodeModuleChoice(
  editor: ModuleChoiceEditor,
  input: ModuleChoiceValue,
): string {
  const choice = editor.choices.find((item) => item.value === input.value);
  if (!choice) throw new Error("Unknown module choice");
  const entries = choice.parameters.map((field) => {
    const value = input.parameters[field.id] ?? field.default;
    return `${field.id}=${field.type === "boolean" ? (z.boolean().parse(value) ? "on" : "off") : z.tuple([Color, Color]).parse(value).join("|")}`;
  });
  if (choice.preserveParameters)
    for (const [key, value] of Object.entries(input.parameters)) {
      if (choice.parameters.some((field) => field.id === key)) continue;
      Id.parse(key);
      const encoded = Array.isArray(value)
        ? value.join("|")
        : typeof value === "boolean"
          ? value
            ? "on"
            : "off"
          : String(value);
      if (encoded.includes(";")) throw new Error("Invalid choice parameter");
      entries.push(`${key}=${encoded}`);
    }
  return [choice.value, ...entries].join(";");
}

export const ModuleMatrixConditionSchema = z.strictObject({
  field: Id,
  values: z.array(Scalar).min(1).max(256),
  /** Match the selected choice independently of its parameter form. */
  choice: z.boolean().optional(),
  negate: z.boolean().optional(),
});
const FieldOverridesSchema = z.strictObject({
  textColor: Color.optional(),
  type: z.enum(["text", "number", "boolean", "choice", "color"]).optional(),
  fill: z.enum(["copy", "series"]).optional(),
  required: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  choices: z
    .array(
      z.strictObject({
        value: z.string().max(160),
        label: Label,
        textColor: Color.optional(),
      }),
    )
    .max(256)
    .optional(),
  /** A pair stores inactive | active colours using the shared colour editor. */
  colorMode: z.enum(["single", "pair", "palette"]).optional(),
  colorPalette: ModuleColorPaletteSchema.optional(),
  orderedNumbers: ModuleOrderedNumbersSchema.nullable().optional(),
});
/** Stable legacy source IDs remain readable; new fields use the public module namespace. */
export const MODULE_MATRIX_LEGACY_FIELD_IDS = [
  "followMode",
  "tallyAddress",
  "tallyScreen",
  "glowCycleMs",
  "targetColumnId",
  "indication",
  "enabled",
  "delayMs",
  "outcome",
  "failureMessage",
  "source",
  "destinationMode",
  "destination",
  "levels",
  "drivesTally",
  "feedbackColor",
  "cameraNumber",
  "gridLocked",
  "actionType",
  "actionGroup",
  "actionValue",
  "feedback",
  "assignmentMode",
  "sequence",
  "slotId",
  "cameraId",
  "feedNumber",
  "feedId",
  "target",
  "applicationBundleId",
  "menuPath",
  "key",
  "modifiers",
  "requestTarget",
  "body",
  "header",
  "contenttype",
] as const;
export const ModuleMatrixFieldIdSchema = z.union([
  z.enum(MODULE_MATRIX_LEGACY_FIELD_IDS),
  z
    .string()
    .regex(
      /^module\.[a-zA-Z0-9][a-zA-Z0-9_.-]{0,88}$/u,
      "Custom Matrix fields must use module.<name>",
    ),
]);
export const ModuleMatrixFieldSchema = z.strictObject({
  textColor: Color.optional(),
  id: ModuleMatrixFieldIdSchema,
  label: Label,
  type: z.enum(["text", "number", "boolean", "choice", "color"]),
  default: Scalar,
  required: z.boolean().default(false),
  showIncompleteWarning: z.boolean().optional(),
  formula: z.boolean().default(false),
  width: z.int().min(48).max(640).default(180),
  choiceProvider: Id.optional(),
  shortcut: ModuleShortcutEditorSchema.optional(),
  choiceFields: z.array(Id).min(1).max(16).optional(),
  emptyMessage: z.string().max(1000).optional(),
  onChoose: z.record(Id, Scalar).optional(),
  numberRanges: z
    .array(z.strictObject({ min: z.number(), max: z.number() }))
    .min(1)
    .max(16)
    .optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  fill: z.enum(["copy", "series"]).default("copy"),
  hidden: z.boolean().optional(),
  enabledWhen: z.array(ModuleMatrixConditionSchema).max(16).optional(),
  choices: z
    .array(
      z.strictObject({
        value: z.string().max(160),
        label: Label,
        textColor: Color.optional(),
      }),
    )
    .max(256)
    .optional(),
  choiceEditor: ModuleChoiceEditorSchema.optional(),
  colorMode: z.enum(["single", "pair", "palette"]).optional(),
  colorPalette: ModuleColorPaletteSchema.optional(),
  orderedNumbers: ModuleOrderedNumbersSchema.nullable().optional(),
  rules: z
    .array(
      z.strictObject({
        when: z.array(ModuleMatrixConditionSchema).min(1).max(16),
        set: FieldOverridesSchema,
      }),
    )
    .max(16)
    .optional(),
});
const FeedbackEffect = z.strictObject({
  kind: z.enum(["blink", "fade"]),
  /** One full cycle in milliseconds: on and off, or bright to dim and back. */
  cycleMs: z.int().min(200).max(10000),
});

/** The colour field whose cell edits a matrix's trigger looks, when it declares triggers. */
export function matrixTriggerFieldId(matrix: {
  readonly triggers?: readonly unknown[] | undefined;
  readonly triggerField?: string | undefined;
  readonly fields: readonly { readonly id: string; readonly type: string }[];
}): string | undefined {
  if (!matrix.triggers?.length && matrix.triggerField === undefined)
    return undefined;
  const colours = matrix.fields.filter((field) => field.type === "color");
  return matrix.triggerField === undefined
    ? colours[0]?.id
    : colours.find((field) => field.id === matrix.triggerField)?.id;
}

/** A named feedback state and the key part it lights by default. Requires module-feedback-triggers-v1. */
export const ModuleFeedbackTriggerSchema = z.strictObject({
  id: Id,
  label: Label,
  part: z.enum(["background", "outline", "bar"]),
  color: Color,
  effect: FeedbackEffect.optional(),
  /**
   * The rows this trigger belongs to, such as one action type; every row when absent. Rows
   * only list, edit and light their own triggers. Requires module-feedback-trigger-conditions-v1.
   */
  when: z.array(ModuleMatrixConditionSchema).min(1).max(16).optional(),
});
export type ModuleFeedbackTrigger = z.infer<typeof ModuleFeedbackTriggerSchema>;

/** The triggers that belong to a row with these field values, in priority order. */
export function matrixTriggersFor<
  Trigger extends {
    readonly when?:
      | readonly z.infer<typeof ModuleMatrixConditionSchema>[]
      | undefined;
  },
>(
  triggers: readonly Trigger[] | undefined,
  values: Readonly<Record<string, unknown>>,
): Trigger[] {
  return (triggers ?? []).filter((trigger) =>
    moduleMatrixMatches(trigger.when, values),
  );
}

const MatrixDefinitionSchema = z
  .strictObject({
    id: Id,
    label: Label,
    actionId: Id,
    feedbackId: Id,
    primaryField: Id,
    /** Include the logical workspace alias in execution/feedback and choice context. */
    context: z.boolean().optional(),
    /** Workspace-owned actions may retain optional logical connection contexts of these types.
     * The host resolves the alias and enforces connection enablement before execution. */
    workspaceContextTypes: z.array(Id).min(1).max(32).optional(),
    fields: z.array(ModuleMatrixFieldSchema).min(1).max(32),
    inactiveWhen: z
      .array(ModuleMatrixConditionSchema)
      .min(1)
      .max(16)
      .optional(),
    observerWhen: z
      .array(ModuleMatrixConditionSchema)
      .min(1)
      .max(16)
      .optional(),
    /** Local-only actions that remain available with physical device I/O disabled. */
    availableWhenDisabled: z
      .array(ModuleMatrixConditionSchema)
      .min(1)
      .max(16)
      .optional(),
    columnSettings: ModuleFieldsSchema.default([]),
    columnDescription: z.string().max(1000).optional(),
    /**
     * Feedback states, highest priority first. A row's feedback reports which are on; each
     * lights its part, and when two want the same part the higher one wins. Operators can
     * change any trigger's look per row. Requires module-feedback-triggers-v1.
     */
    triggers: z.array(ModuleFeedbackTriggerSchema).max(16).optional(),
    /** The colour field whose cell edits the triggers' looks; the first colour field if absent. */
    triggerField: Id.optional(),
    /**
     * Whether the column's cells show live feedback colours in the Button Matrix; on when absent.
     * Operators can turn them on or off for one column from its right-click menu, which keys
     * never follow. Requires module-matrix-feedback-colors-v1.
     */
    showFeedbackColors: z.boolean().optional(),
    /**
     * Press rows that also answer a hold of this length, such as one action type; every press row
     * when `when` is absent. Their keys get a hold lane, so the press runs when the key is let go
     * before then and the hold runs once it is reached. The module reads which from the execution
     * context's `gesture`. Rows already timed to a hold are left as they are. Requires
     * module-matrix-hold-v1.
     */
    hold: z
      .strictObject({
        ms: z.union([z.literal(1000), z.literal(2000), z.literal(3000)]),
        when: z.array(ModuleMatrixConditionSchema).min(1).max(16).optional(),
      })
      .optional(),
    mapping: z
      .strictObject({
        label: Label,
        description: z.string().max(1000),
        fields: z.array(Id).min(1).max(16),
        defaults: z.record(Id, Scalar),
      })
      .optional(),
    columnControls: z
      .array(z.strictObject({ id: Id, label: Label }))
      .max(16)
      .default([]),
    /** Variants depend on the connection settings, never on a host module name. */
    variants: z
      .array(
        z.strictObject({
          when: z.array(ModuleMatrixConditionSchema).min(1).max(16),
          fields: z.record(
            Id,
            z.strictObject({
              hidden: z.boolean().optional(),
              min: z.number().optional(),
              max: z.number().optional(),
              default: Scalar.optional(),
              onChoose: z.record(Id, Scalar).optional(),
              textColor: Color.optional(),
            }),
          ),
        }),
      )
      .max(16)
      .default([]),
    /** Compatibility mapping only. Runtime behavior still belongs to the module. */
    legacy: z
      .strictObject({
        adapter: Id,
        settingsKey: Id.optional(),
        normalize: z.boolean().optional(),
        connectionType: Id.optional(),
      })
      .optional(),
  })
  .superRefine((matrix, ctx) => {
    if (
      matrix.workspaceContextTypes &&
      (!matrix.context ||
        new Set(matrix.workspaceContextTypes).size !==
          matrix.workspaceContextTypes.length)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Workspace context types require logical context and unique connection types",
      });
    if (matrix.legacy?.connectionType && !matrix.legacy.normalize)
      ctx.addIssue({
        code: "custom",
        message:
          "Connection envelope migration requires explicit legacy normalization",
      });
    if (JSON.stringify(matrix).length > 65536)
      ctx.addIssue({
        code: "custom",
        message: "Matrix descriptor exceeds 64 KiB",
      });
    if (
      new Set(matrix.triggers?.map(({ id }) => id)).size !==
      (matrix.triggers?.length ?? 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Matrix triggers require unique IDs",
      });
    const fieldIds = new Set(matrix.fields.map(({ id }) => id));
    if (
      matrix.triggers?.some((trigger) =>
        trigger.when?.some(({ field }) => !fieldIds.has(field)),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Trigger conditions must name declared fields",
      });
    if (matrix.hold?.when?.some(({ field }) => !fieldIds.has(field)))
      ctx.addIssue({
        code: "custom",
        message: "Hold conditions must name declared fields",
      });
    if (
      (matrix.triggers?.length || matrix.triggerField) &&
      matrixTriggerFieldId(matrix) === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "Matrix triggers require a colour field to edit them from",
      });
    const ids = new Set(matrix.fields.map((field) => field.id));
    if (ids.size !== matrix.fields.length || !ids.has(matrix.primaryField))
      ctx.addIssue({
        code: "custom",
        message:
          "Matrix fields require unique IDs and a declared primary field",
      });
    for (const target of [
      ...Object.keys(
        matrix.variants
          .flatMap((variant) => Object.entries(variant.fields))
          .reduce((all, [key]) => ({ ...all, [key]: true }), {}),
      ),
      ...(matrix.mapping?.fields ?? []),
      ...Object.keys(matrix.mapping?.defaults ?? {}),
    ])
      if (!ids.has(target))
        ctx.addIssue({
          code: "custom",
          message: "Unknown matrix target field",
        });
    for (const field of matrix.fields) {
      if (
        field.shortcut &&
        (!["text", "choice"].includes(field.type) ||
          field.id === field.shortcut.modifiersField ||
          field.choiceProvider ||
          field.choiceEditor ||
          !matrix.fields.some(
            (other) =>
              other.id === field.shortcut?.modifiersField &&
              other.type === "text" &&
              !other.shortcut,
          ) ||
          matrix.fields.filter(
            (other) =>
              other.shortcut?.modifiersField === field.shortcut?.modifiersField,
          ).length !== 1)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Shortcut editor requires a unique sibling text modifiers field and no other editor",
        });
      for (const candidate of [
        field,
        ...(field.rules ?? []).map((rule) => ({ ...field, ...rule.set })),
      ]) {
        if (
          candidate.colorMode === "palette" &&
          (!candidate.colorPalette ||
            !ids.has(candidate.colorPalette.itemsField))
        )
          ctx.addIssue({
            code: "custom",
            message:
              "Colour palettes require defaults and a declared items field",
          });
        if (candidate.orderedNumbers && candidate.type !== "text")
          ctx.addIssue({
            code: "custom",
            message: "Ordered numbers require a text field",
          });
      }
      if (field.id === "enabled" && field.type !== "boolean")
        ctx.addIssue({
          code: "custom",
          message: "The shared Enabled field must be boolean",
        });
      if (
        !matrix.legacy &&
        !["enabled", "actionType"].includes(field.id) &&
        !/^module\.[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(field.id)
      )
        ctx.addIssue({
          code: "custom",
          message: "Custom Matrix fields must use the module. namespace",
        });
      if (Object.keys(field.onChoose ?? {}).some((id) => !ids.has(id)))
        ctx.addIssue({ code: "custom", message: "Unknown companion field" });
      if (
        field.choiceFields &&
        (!field.choiceProvider ||
          new Set(field.choiceFields).size !== field.choiceFields.length ||
          field.choiceFields.some((id) => !ids.has(id)))
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Choice bindings require a provider and unique declared fields",
        });
      if (field.choiceEditor && field.type !== "choice")
        ctx.addIssue({
          code: "custom",
          message: "Choice editor requires a choice field",
        });
      if (field.enabledWhen?.some((condition) => !ids.has(condition.field)))
        ctx.addIssue({
          code: "custom",
          message: "Unknown matrix condition field",
        });
      if (
        field.rules?.some((rule) =>
          rule.when.some(
            (condition) =>
              !ids.has(condition.field) || condition.field === field.id,
          ),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Field rules must reference other declared Matrix fields",
        });
    }
    if (matrix.observerWhen?.some((condition) => !ids.has(condition.field)))
      ctx.addIssue({
        code: "custom",
        message: "Unknown observer condition field",
      });
    if (
      matrix.availableWhenDisabled?.some(
        (condition) => !ids.has(condition.field),
      )
    )
      ctx.addIssue({
        code: "custom",
        message: "Unknown disabled-action condition field",
      });
  });
// Named boundary keeps downstream generated declarations within TypeScript serialization limits.
export interface ModuleMatrix extends z.infer<typeof MatrixDefinitionSchema> {
  id: string;
}
export const ModuleMatrixSchema: z.ZodType<ModuleMatrix> =
  MatrixDefinitionSchema;
export type ModuleMatrixField = z.infer<typeof ModuleMatrixFieldSchema>;

/** Resolve a row's editor and constraints using package declarations only. */
export function resolveModuleMatrixField(
  field: ModuleMatrixField,
  values: Readonly<Record<string, unknown>>,
): ModuleMatrixField {
  let resolved: ModuleMatrixField = { ...field, rules: undefined };
  for (const rule of field.rules ?? [])
    if (moduleMatrixMatches(rule.when, values))
      resolved = {
        ...resolved,
        ...rule.set,
        type: rule.set.type ?? resolved.type,
        required: rule.set.required ?? resolved.required,
        fill: rule.set.fill ?? resolved.fill,
      };
  return resolved;
}

export function moduleMatrixMatches(
  conditions:
    | readonly z.infer<typeof ModuleMatrixConditionSchema>[]
    | undefined,
  values: Readonly<Record<string, unknown>>,
): boolean {
  return (
    conditions?.every((condition) => {
      const raw = values[condition.field];
      const value =
        condition.choice && typeof raw === "string" ? raw.split(";")[0] : raw;
      return (
        condition.values.includes(value as z.infer<typeof Scalar>) !==
        (condition.negate === true)
      );
    }) ?? true
  );
}

export function resolveModuleMatrix(
  matrix: ModuleMatrix,
  settings: Readonly<Record<string, unknown>>,
): ModuleMatrix {
  let fields = matrix.fields;
  for (const variant of matrix.variants)
    if (moduleMatrixMatches(variant.when, settings))
      fields = fields.map((field) =>
        ModuleMatrixFieldSchema.parse({
          ...field,
          ...variant.fields[field.id],
        }),
      );
  return { ...matrix, fields };
}

export const ModuleFeedbackSubscriptionSchema = z.strictObject({
  id: Id,
  fields: z.record(Id, z.json()),
});
export const ModuleFeedbackSubscriptionsSchema = z
  .array(ModuleFeedbackSubscriptionSchema)
  .max(8192);
export type ModuleFeedbackSubscription = z.infer<
  typeof ModuleFeedbackSubscriptionSchema
>;
export const ModuleFeedbackAppearanceSchema = z.strictObject({
  /** The row's feedback colour. Hubble puts it on the key part the operator chose. */
  backgroundColor: Color.nullable().optional(),
  /** Lights the key's outline, whatever part the operator chose. Requires module-feedback-key-parts-v1. */
  outlineColor: Color.nullable().optional(),
  /** Lights the key's bar, whatever part the operator chose. Requires module-feedback-key-parts-v1. */
  barColor: Color.nullable().optional(),
  /** Makes a lit outline blink or fade. Requires module-feedback-key-effects-v1. */
  outlineEffect: FeedbackEffect.nullable().optional(),
  /** Makes a lit bar blink or fade. Requires module-feedback-key-effects-v1. */
  barEffect: FeedbackEffect.nullable().optional(),
  /** Makes a lit background blink or fade. Requires module-feedback-triggers-v1. */
  backgroundEffect: FeedbackEffect.nullable().optional(),
  /**
   * The matrix's triggers that are on for this row. When present, the host draws the key from
   * the triggers' looks and ignores the colours and effects above. Requires
   * module-feedback-triggers-v1.
   */
  triggers: z.array(Id).max(16).nullable().optional(),
  glow: z
    .strictObject({ color: Color, cycleMs: z.int().min(500).max(10000) })
    .nullable()
    .optional(),
  cells: z
    .record(
      Id,
      z.strictObject({
        color: Color.nullable(),
        label: z.string().max(160).optional(),
        /** Editable/clipboard input for a resolved legacy reference; never changes saved source. */
        inputSource: z.string().max(4096).optional(),
      }),
    )
    .refine((cells) => Object.keys(cells).length <= 32)
    .optional(),
});
export type ModuleFeedbackAppearance = z.infer<
  typeof ModuleFeedbackAppearanceSchema
>;

export function parseModuleMatrixValue(
  field: ModuleMatrixField,
  value: unknown,
): string | number | boolean | null {
  // Dependent constraints are applied after the other row values/formulas resolve.
  if (field.rules?.length) return Scalar.parse(value ?? null);
  if (
    value === "" &&
    field.choiceEditor?.choices.some((choice) => choice.value === "")
  )
    return "";
  if (
    (value === "" || value === null || value === undefined) &&
    !field.required
  )
    return field.default;
  if (field.type === "number") {
    const number = typeof value === "number" ? value : Number(value);
    if (
      value === "" ||
      value === null ||
      value === undefined ||
      !Number.isFinite(number) ||
      (field.integer && !Number.isInteger(number)) ||
      (field.min !== undefined && number < field.min) ||
      (field.max !== undefined && number > field.max) ||
      (field.numberRanges &&
        !field.numberRanges.some(
          (range) => number >= range.min && number <= range.max,
        ))
    )
      throw new Error(`Invalid ${field.label}`);
    return number;
  }
  if (field.type === "boolean") {
    if (typeof value === "boolean") return value;
    if (String(value).toUpperCase() === "TRUE") return true;
    if (String(value).toUpperCase() === "FALSE") return false;
    throw new Error(`Invalid ${field.label}`);
  }
  if (
    value !== null &&
    value !== undefined &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    throw new Error(`Invalid ${field.label}`);
  const text = String(value ?? "");
  if (text.length > 4096 || (field.required && !text))
    throw new Error(`Invalid ${field.label}`);
  if (field.orderedNumbers) {
    const parsed = parseModuleOrderedNumbers(text, field.orderedNumbers);
    if (!parsed.success) throw new Error(parsed.message);
    return parsed.canonical;
  }
  if (field.type === "color" && field.colorMode === "palette") {
    if (
      !field.colorPalette ||
      !parseModuleColorPalette(text, field.colorPalette.defaults.length)
    )
      throw new Error(`Invalid ${field.label}`);
    return text;
  }
  if (
    field.type === "color" &&
    !(
      field.colorMode === "pair"
        ? /^#[0-9a-f]{6}(?:\s*\|\s*#[0-9a-f]{6})?$/iu
        : /^#[0-9a-f]{6}$/iu
    ).test(text.trim())
  )
    throw new Error(`Invalid ${field.label}`);
  if (
    field.choiceEditor
      ? !decodeModuleChoice(field.choiceEditor, text)
      : field.type === "choice" &&
        !field.choices?.some((choice) => choice.value === text)
  )
    throw new Error(`Choose ${field.label}`);
  return text;
}
