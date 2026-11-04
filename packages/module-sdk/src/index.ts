import {
  ModuleWorkbookFieldRuleSchema,
  moduleWorkbookEditOrder,
  validateModuleWorkbookRow,
} from "./workbook-rules.js";
export * from "./workbook-rules.js";
import type { ModuleDocumentMigrationInput } from "./documents.js";
import { ModuleFrontendSectionSchema } from "./frontend.js";
import { ModuleHelperDefinitionSchema } from "./helpers.js";
export * from "./helpers.js";
import {
  ModuleDocumentDefinitionSchema,
  ModuleDocumentValueSchema,
} from "./documents.js";
export * from "./documents.js";
export * from "./datasets.js";
export * from "./contexts.js";
export * from "./native-menus.js";
export * from "./collections.js";
export * from "./document-client.js";
export * from "./frontend.js";
export { parseModuleMatrixValue } from "./matrix.js";
import {
  ModuleMatrixSchema,
  ModuleFeedbackAppearanceSchema,
  type ModuleFeedbackSubscription,
} from "./matrix.js";
export * from "./matrix.js";
import { ModulePageControlsSchema } from "./page-controls.js";
export * from "./page-controls.js";
import {
  ModuleTableWorkbookSchema,
  moduleTableViewState,
} from "./table-workbook.js";
export * from "./table-workbook.js";
import type { DiagnosticError } from "./diagnostics.js";
export * from "./exchange.js";
import {
  ModuleExchangeDefinitionSchema,
  type ModuleExchange,
  type ModuleDataQuery,
} from "./exchange-contracts.js";
import { z } from "zod";
import { ModuleVersionSchema, type ModuleInstanceScope } from "./identity.js";
import {
  compareModuleVersions,
  ModuleHostRequirementsSchema,
} from "./compatibility.js";
export * from "./identity.js";
export * from "./diagnostics.js";
export * from "./choices.js";
export * from "./saved-actions.js";
export * from "./host-services.js";
import type { ModuleHostServices } from "./host-services.js";
import type { ModuleSavedActions } from "./saved-actions.js";
import type { ModuleChoiceQuery, ModuleChoicePage } from "./choices.js";
export * from "./compatibility.js";
export * from "./release-metadata.js";

/** API 1: qualified with the HTTP Requests and DIT Browse external pilots. */
export const MODULE_API_VERSION = 1 as const;
export const MODULE_GESTURES = [
  "press",
  "rotate-left",
  "rotate-right",
  "long-press-1s",
  "long-press-2s",
  "long-press-3s",
] as const;

export const ModuleIdSchema = z
  .string()
  .min(3)
  .max(96)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/u);
export const ModuleIdentifierSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
export const ModuleFilePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.includes(":") &&
      value
        .split("/")
        .every(
          (part) =>
            /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(part) &&
            !part.endsWith(".") &&
            !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
        ),
    "Expected a portable relative file path without traversal or special segments",
  );
const LabelSchema = z.string().trim().min(1).max(160);
const DescriptionSchema = z.string().trim().min(1).max(1_000);
export * from "./fields.js";
import {
  ModuleFieldsSchema as FieldsSchema,
  moduleFieldsRequireV2,
  moduleFieldsAllowEmptyNumbers,
  moduleFieldDefault,
  moduleFieldsContainSecrets,
  validateModuleFields,
  type ModuleChoice,
  type ModuleField,
} from "./fields.js";
/** Shared controls and isolated package frontends compose module-owned screens. */
export const ModulePageTableSchema = z.strictObject({
  type: z.literal("table"),
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  description: DescriptionSchema.optional(),
  source: z.enum(["settings", "state", "document"]),
  documentId: ModuleIdentifierSchema.optional(),
  dataset: z
    .strictObject({
      id: ModuleIdentifierSchema,
      version: z.int().min(1).max(65535),
    })
    .optional(),
  workbook: ModuleTableWorkbookSchema.optional(),
  selectionHighlight: z.enum(["cell", "row"]).optional(),
  rowHighlight: z
    .strictObject({
      field: ModuleIdentifierSchema,
      values: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .min(1)
        .max(32),
      color: z.string().regex(/^#[0-9a-f]{6}$/iu),
    })
    .optional(),
  live: z
    .strictObject({
      source: ModuleIdentifierSchema,
      columns: z.array(ModuleIdentifierSchema).min(1).max(32),
    })
    .optional(),
  computed: z
    .strictObject({
      source: ModuleIdentifierSchema,
      columns: z.array(ModuleIdentifierSchema).min(1).max(32),
      dependencies: z
        .strictObject({
          rowFields: z.array(ModuleIdentifierSchema).max(32),
          settingsFields: z.array(ModuleIdentifierSchema).max(128),
        })
        .optional(),
      preview: z
        .strictObject({
          id: ModuleIdentifierSchema,
          version: z.int().positive(),
        })
        .optional(),
    })
    .optional(),
  choiceDependencies: z
    .record(ModuleIdentifierSchema, z.array(ModuleIdentifierSchema).max(32))
    .optional(),
  autoNumber: ModuleIdentifierSchema.optional(),
  columns: FieldsSchema.refine(
    (fields) => fields.length > 0 && fields.length <= 32,
    "Expected 1–32 columns",
  ),
  maxRows: z.int().min(1).max(512),
  fieldRules: z.array(ModuleWorkbookFieldRuleSchema).max(64).optional(),
});
export const ModulePageSchema = z.strictObject({
  /** Full-page is a single package-owned frontend; omission retains section layout. */
  layout: z.enum(["sections", "full-page"]).optional(),
  navigation: z
    .strictObject({
      replaces: z.enum(["tally-switch", "ccc", "router"]).optional(),
      relatedCapabilities: z.array(ModuleIdentifierSchema).max(8).optional(),
    })
    .optional(),
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  description: DescriptionSchema.optional(),
  sections: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({
          type: z.literal("settings"),
          id: ModuleIdentifierSchema,
          label: LabelSchema,
          fields: z.array(ModuleIdentifierSchema).min(1).max(128),
        }),
        ModulePageTableSchema,
        ModuleFrontendSectionSchema,
        ModulePageControlsSchema,
        z.strictObject({
          type: z.literal("status"),
          id: ModuleIdentifierSchema,
          label: LabelSchema,
          fields: z
            .array(
              z.strictObject({
                id: ModuleIdentifierSchema,
                label: LabelSchema,
              }),
            )
            .max(32),
        }),
      ]),
    )
    .min(1)
    .max(16),
});
export const ModuleTableRowsSchema = z
  .array(
    z
      .strictObject({
        id: ModuleIdentifierSchema,
        values: z.record(ModuleIdentifierSchema, z.json()),
        formulas: z
          .record(
            ModuleIdentifierSchema,
            z.string().min(2).max(4096).startsWith("="),
          )
          .optional(),
      })
      .transform(
        (row): ModuleTableRow => ({
          id: row.id,
          values: row.values,
          ...(row.formulas ? { formulas: row.formulas } : {}),
        }),
      ),
  )
  .max(512)
  .superRefine((rows, ctx) => {
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      ctx.addIssue({ code: "custom", message: "Duplicate table row ID" });
  });
export type ModulePage = z.infer<typeof ModulePageSchema>;
export type ModulePageTable = z.infer<typeof ModulePageTableSchema>;
export type ModuleTableRow = {
  id: string;
  values: Record<string, z.infer<ReturnType<typeof z.json>>>;
  formulas?: Record<string, string>;
};
/** Computed values are observations, never editable or portable settings. */
export function moduleTableInputColumns(table: ModulePageTable) {
  return table.columns.filter(
    (field) => !table.computed?.columns.includes(field.id),
  );
}

export const ModuleCompletionSchema = z.enum([
  "local",
  "submitted",
  "response",
  "state-confirmed",
]);
export const ModuleActionSchema = z.strictObject({
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  group: LabelSchema.optional(),
  description: DescriptionSchema,
  fields: FieldsSchema,
  legacy: z.boolean().optional(),
  completion: ModuleCompletionSchema,
  completionAlternatives: z.array(ModuleCompletionSchema).max(3).optional(),
  timeoutMs: z.int().min(25).max(120_000),
});
export const ModuleFeedbackDefinitionSchema = z.strictObject({
  id: ModuleIdentifierSchema,
  label: LabelSchema,
  group: LabelSchema.optional(),
  description: DescriptionSchema,
  fields: FieldsSchema,
});
export const ModuleManifestSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    id: ModuleIdSchema,
    name: LabelSchema,
    version: ModuleVersionSchema,
    apiVersion: z.literal(MODULE_API_VERSION),
    host: ModuleHostRequirementsSchema,
    configVersion: z.int().min(1).max(65_535),
    savedActionVersion: z.int().min(1).max(65_535).optional(),
    entry: ModuleFilePathSchema.refine(
      (value) => value.endsWith(".mjs"),
      "Entry must be bundled ESM (.mjs)",
    ),
    files: z.array(ModuleFilePathSchema).min(1).max(128),
    capabilities: z.array(ModuleIdentifierSchema).max(128),
    settings: FieldsSchema,
    settingsUpdate: z.literal("live").optional(),
    actions: z.array(ModuleActionSchema).max(256),
    /** False keeps actions available to peers and saved documents, but hides new Matrix/Advanced authoring. */
    actionUi: z.boolean().optional(),
    feedback: z.array(ModuleFeedbackDefinitionSchema).max(256),
    pages: z.array(ModulePageSchema).max(16).optional(),
    matrix: ModuleMatrixSchema.optional(),
    exchange: ModuleExchangeDefinitionSchema.optional(),
    documents: z.array(ModuleDocumentDefinitionSchema).max(64).optional(),
    helpers: z.array(ModuleHelperDefinitionSchema).max(8).optional(),
    /** Workspace packages use one stable instance per module ID in each workspace. */
    instanceScope: z.enum(["connection", "workspace"]).optional(),
    /** Keep local settings/state available while physical I/O is disabled. The module must honor context.connectionEnabled. */
    lifecycle: z.strictObject({ runWhenDisabled: z.literal(true) }).optional(),
  })
  .superRefine((manifest, ctx) => {
    const features =
      "requiredFeatures" in manifest.host
        ? (manifest.host.requiredFeatures ?? [])
        : [];
    if (
      manifest.matrix?.fields.some(
        (field) => field.showIncompleteWarning !== undefined,
      ) &&
      !features.includes("module-matrix-quiet-incomplete-v1")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Incomplete warning presentation requires module-matrix-quiet-incomplete-v1",
      });
    if (
      !features.includes("module-workbook-formula-choice-labels-v1") &&
      (manifest.pages ?? [])
        .flatMap((page) => page.sections)
        .some(
          (table) =>
            table.type === "table" &&
            table.workbook?.formulaChoiceValues === "label",
        )
    )
      ctx.addIssue({
        code: "custom",
        path: ["host", "requiredFeatures"],
        message:
          "Choice labels in formulas require module-workbook-formula-choice-labels-v1",
      });
    if (
      manifest.actionUi !== undefined &&
      !features.includes("module-action-authoring-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message:
          "Action authoring visibility requires module-action-authoring-v1",
      });
    const hasShortcut = (fields: ModuleField[]): boolean =>
      fields.some(
        (field) =>
          !!field.shortcut ||
          (field.type === "object" && hasShortcut(field.fields)) ||
          (field.type === "array" && hasShortcut([field.item])),
      );
    if (
      (manifest.matrix?.fields.some((field) => field.shortcut) ||
        hasShortcut([
          ...manifest.settings,
          ...manifest.actions.flatMap((action) => action.fields),
          ...manifest.feedback.flatMap((feedback) => feedback.fields),
          ...(manifest.matrix?.columnSettings ?? []),
        ])) &&
      !features.includes("module-shortcut-editor-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Shortcut editors require module-shortcut-editor-v1",
      });
    if (
      features.includes("module-native-controls-v1") &&
      (!features.includes("host-service-registry-v1") ||
        !manifest.capabilities.includes("host.keyboard"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message:
          "Native controls require host-service-registry-v1 and host.keyboard",
      });
    if (
      (features.includes("module-native-menus-v1") ||
        manifest.capabilities.includes("host.native-menus")) &&
      (!features.includes("module-native-menus-v1") ||
        !features.includes("host-service-registry-v1") ||
        !manifest.capabilities.includes("host.native-menus"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message:
          "Native menu access requires module-native-menus-v1, host-service-registry-v1 and host.native-menus",
      });
    if (
      manifest.matrix?.availableWhenDisabled &&
      !manifest.lifecycle?.runWhenDisabled
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix", "availableWhenDisabled"],
        message:
          "Local Matrix actions require the disabled connection lifecycle",
      });
    if (
      manifest.lifecycle &&
      (manifest.instanceScope === "workspace" ||
        !features.includes("module-disabled-state-v1"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["lifecycle"],
        message:
          "Disabled connection state requires connection scope and module-disabled-state-v1",
      });
    if (
      manifest.documents?.some(
        (document) => document.migrate || document.legacyImport,
      ) &&
      !features.includes("module-document-migrations-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["documents"],
        message: "Document migrations require module-document-migrations-v1",
      });
    for (const document of manifest.documents ?? [])
      if (document.legacyImport && !document.migrate)
        ctx.addIssue({
          code: "custom",
          path: ["documents"],
          message: "Legacy document imports require a package migration",
        });
    for (const document of manifest.documents ?? [])
      if (
        document.prepare &&
        !manifest.exchange?.data.some(
          (data) =>
            data.id === document.prepare?.id &&
            data.version === document.prepare.version &&
            data.query,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["documents"],
          message:
            "Document preparation must reference a declared read-only data query",
        });
    if (
      manifest.documents?.some((document) => document.prepare) &&
      !features.includes("module-document-preparation-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["documents"],
        message: "Document preparation requires module-document-preparation-v1",
      });
    if (
      manifest.instanceScope === "workspace" &&
      !features.includes("module-workspace-instances-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["instanceScope"],
        message: "Workspace instances require module-workspace-instances-v1",
      });
    if (manifest.helpers?.length) {
      if (
        !features.includes("module-helpers-v1") ||
        !manifest.capabilities.includes("host.helpers")
      )
        ctx.addIssue({
          code: "custom",
          path: ["helpers"],
          message: "Helpers require module-helpers-v1 and host.helpers",
        });
      if (
        new Set(manifest.helpers.map((helper) => helper.id)).size !==
        manifest.helpers.length
      )
        ctx.addIssue({
          code: "custom",
          path: ["helpers"],
          message: "Duplicate helper identity",
        });
      for (const helper of manifest.helpers)
        for (const variant of helper.variants)
          if (!manifest.files.includes(variant.entry))
            ctx.addIssue({
              code: "custom",
              path: ["helpers"],
              message: "Helper entry must be a declared package file",
            });
    }
    if (
      manifest.capabilities.includes("host.contexts") &&
      !features.includes("module-contexts-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Context access requires module-contexts-v1",
      });
    if (
      manifest.capabilities.includes("host.datasets") &&
      !features.includes("module-datasets-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Dataset access requires module-datasets-v1",
      });
    if (manifest.documents?.length) {
      if (
        !features.includes("module-documents-v1") ||
        !manifest.capabilities.includes("host.documents")
      )
        ctx.addIssue({
          code: "custom",
          path: ["documents"],
          message: "Documents require module-documents-v1 and host.documents",
        });
      if (
        new Set(manifest.documents.map((document) => document.id)).size !==
        manifest.documents.length
      )
        ctx.addIssue({
          code: "custom",
          path: ["documents"],
          message: "Duplicate module document declaration",
        });
    }
    if (
      manifest.capabilities.includes("host.resources") &&
      !["host-service-registry-v1", "module-resource-limits-v1"].every(
        (feature) => features.includes(feature),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message:
          "Resource leases require host-service-registry-v1 and module-resource-limits-v1",
      });
    if (
      manifest.matrix &&
      (!("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-matrix-v1") ||
        !manifest.host.requiredFeatures.includes(
          "module-feedback-observers-v1",
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Module Matrix requires module-matrix-v1 and module-feedback-observers-v1",
      });
    if (manifest.matrix?.context && !features.includes("module-contexts-v1"))
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Logical Matrix context requires module-contexts-v1",
      });
    if (
      manifest.matrix?.workspaceContextTypes &&
      (manifest.instanceScope !== "workspace" ||
        !features.includes("module-workspace-contexts-v1"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Workspace connection contexts require workspace scope and module-workspace-contexts-v1",
      });
    if (
      manifest.matrix?.fields.some((field) =>
        [field, ...(field.rules ?? []).map((rule) => rule.set)].some(
          (value) => value.orderedNumbers || value.colorMode === "palette",
        ),
      ) &&
      !features.includes("module-matrix-collections-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Ordered lists and colour palettes require module-matrix-collections-v1",
      });
    if (
      manifest.matrix?.fields.some((field) => field.choiceFields) &&
      !features.includes("module-choice-bindings-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Atomic choice bindings require module-choice-bindings-v1",
      });
    if (
      manifest.matrix &&
      (manifest.matrix.legacy?.normalize ||
        manifest.matrix.variants.some((variant) =>
          variant.when.some(
            (condition) => condition.field === "column.commandId",
          ),
        )) &&
      (!("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-matrix-context-v1"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Matrix column context and legacy normalization require module-matrix-context-v1",
      });
    if (
      manifest.matrix &&
      (manifest.savedActionVersion ?? 1) > 1 &&
      !features.includes("module-matrix-migrations-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Native Matrix source migrations require module-matrix-migrations-v1",
      });
    if (
      manifest.matrix?.fields.some((field) =>
        field.rules?.some((rule) => rule.set.fill !== undefined),
      ) &&
      !features.includes("module-matrix-fill-rules-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message:
          "Dependent Matrix fill policies require module-matrix-fill-rules-v1",
      });
    if (
      (manifest.matrix?.fields.some((field) =>
        [field, ...(field.rules ?? []).map((rule) => rule.set)].some(
          (candidate) => candidate.textColor !== undefined,
        ),
      ) ||
        manifest.matrix?.variants.some((variant) =>
          Object.values(variant.fields).some(
            (field) => field.textColor !== undefined,
          ),
        )) &&
      !features.includes("module-matrix-field-presentation-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["host", "requiredFeatures"],
        message:
          "Matrix field text colors require module-matrix-field-presentation-v1",
      });
    if (
      manifest.matrix?.fields.some((field) =>
        [field, ...(field.rules ?? []).map((rule) => rule.set)].some(
          (candidate) =>
            candidate.choices?.some((choice) => choice.textColor !== undefined),
        ),
      ) &&
      !features.includes("module-matrix-choice-presentation-v1")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["host", "requiredFeatures"],
        message:
          "Matrix choice text colors require module-matrix-choice-presentation-v1",
      });
    }
    if (
      manifest.matrix?.fields.some(
        (field) => field.rules?.length || field.colorMode === "pair",
      ) &&
      !features.includes("module-matrix-row-fields-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Dependent Matrix fields require module-matrix-row-fields-v1",
      });
    if (
      manifest.matrix &&
      (!manifest.actions.some(
        (action) => action.id === manifest.matrix?.actionId,
      ) ||
        !manifest.feedback.some(
          (feedback) => feedback.id === manifest.matrix?.feedbackId,
        ))
    )
      ctx.addIssue({
        code: "custom",
        path: ["matrix"],
        message: "Matrix action and feedback IDs must be declared",
      });
    if (
      manifest.settingsUpdate &&
      (!("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-live-settings-v1") ||
        manifest.capabilities.length ||
        moduleFieldsContainSecrets(manifest.settings))
    )
      ctx.addIssue({
        code: "custom",
        path: ["settingsUpdate"],
        message:
          "Live settings require module-live-settings-v1 and an observational module without privileged capabilities or secrets",
      });
    if (
      manifest.exchange &&
      !(
        "requiredFeatures" in manifest.host &&
        manifest.host.requiredFeatures?.includes("module-exchange-v1")
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Module exchange requires module-exchange-v1",
      });
    if (
      manifest.savedActionVersion !== undefined &&
      (!("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-saved-actions-v1"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Saved action migrations require module-saved-actions-v1",
      });
    const fieldSets = [
      manifest.settings,
      ...(manifest.matrix ? [manifest.matrix.columnSettings] : []),
      ...manifest.actions.map((action) => action.fields),
      ...manifest.feedback.map((feedback) => feedback.fields),
      ...(manifest.pages ?? []).flatMap((page) =>
        page.sections.flatMap((section) =>
          section.type === "table"
            ? [section.columns]
            : section.type === "controls"
              ? [section.fields]
              : [],
        ),
      ),
    ];
    if (
      fieldSets.some(moduleFieldsAllowEmptyNumbers) &&
      !features.includes("module-optional-numbers-v1")
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Optional empty numbers require module-optional-numbers-v1",
      });
    if (
      fieldSets.some(moduleFieldsRequireV2) &&
      (!("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-fields-v2"))
    )
      ctx.addIssue({
        code: "custom",
        path: ["host"],
        message: "Rich fields require module-fields-v2",
      });

    if (!manifest.files.includes(manifest.entry))
      ctx.addIssue({
        code: "custom",
        path: ["entry"],
        message: "Entry is not listed in files",
      });
    for (const key of [
      "files",
      "capabilities",
      "actions",
      "feedback",
    ] as const) {
      const values = manifest[key].map((value) =>
        typeof value === "string" ? value : value.id,
      );
      const normalized =
        key === "files" ? values.map((value) => value.toLowerCase()) : values;
      if (new Set(normalized).size !== normalized.length)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Duplicate identity",
        });
    }

    if (manifest.pages?.length) {
      if (
        !("requiredFeatures" in manifest.host) ||
        !manifest.host.requiredFeatures?.includes("module-pages-v1")
      )
        ctx.addIssue({
          code: "custom",
          path: ["host"],
          message: "Pages require module-pages-v1",
        });
      const pageIds = new Set<string>();
      const tableIds = new Set<string>();
      const datasetIds = new Set<string>();
      const settings = new Set(manifest.settings.map((field) => field.id));
      manifest.pages.forEach((page, pageIndex) => {
        if (page.layout !== undefined) {
          if (
            page.layout === "full-page" &&
            (page.sections.length !== 1 || page.sections[0]?.type !== "custom")
          )
            ctx.addIssue({
              code: "custom",
              path: ["pages", pageIndex, "layout"],
              message:
                "Full-page layout requires exactly one custom frontend section",
            });
          if (
            !features.includes("module-custom-pages-full-page-v1") ||
            !("minimumVersion" in manifest.host) ||
            compareModuleVersions(manifest.host.minimumVersion, "2.0.18") < 0
          )
            ctx.addIssue({
              code: "custom",
              path: ["host"],
              message:
                "Page layout requires Hubble 2.0.18 or later and module-custom-pages-full-page-v1",
            });
        }

        if (
          page.navigation &&
          (!("requiredFeatures" in manifest.host) ||
            !manifest.host.requiredFeatures?.includes(
              "module-page-navigation-v1",
            ))
        )
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "navigation"],
            message: "Page composition requires module-page-navigation-v1",
          });
        if (pageIds.has(page.id))
          ctx.addIssue({
            code: "custom",
            path: ["pages", pageIndex, "id"],
            message: "Duplicate page ID",
          });
        pageIds.add(page.id);
        const sectionIds = new Set<string>();
        page.sections.forEach((section, sectionIndex) => {
          const path = ["pages", pageIndex, "sections", sectionIndex];
          if (sectionIds.has(section.id))
            ctx.addIssue({
              code: "custom",
              path,
              message: "Duplicate section ID",
            });
          sectionIds.add(section.id);
          if (section.type === "custom") {
            if (
              !features.includes("module-custom-pages-v1") ||
              !manifest.capabilities.includes(`service.page.${page.id}`)
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Custom pages require module-custom-pages-v1 and their declared page service",
              });
            if (
              !ModuleFilePathSchema.safeParse(section.entry).success ||
              !manifest.files.includes(section.entry)
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Custom page entry must be a declared portable package file",
              });
          }
          if (
            section.type === "controls" &&
            (!("requiredFeatures" in manifest.host) ||
              !manifest.host.requiredFeatures?.includes(
                "module-page-controls-v1",
              ) ||
              !manifest.capabilities.includes(`service.page.${page.id}`))
          )
            ctx.addIssue({
              code: "custom",
              path,
              message:
                "Page controls require module-page-controls-v1 and their page service capability",
            });
          if (
            section.type === "settings" &&
            (new Set(section.fields).size !== section.fields.length ||
              section.fields.some((id) => !settings.has(id)))
          )
            ctx.addIssue({
              code: "custom",
              path,
              message:
                "Settings sections must reference unique declared fields",
            });
          if (section.type === "table") {
            if (
              section.fieldRules &&
              !features.includes("module-workbook-field-rules-v1")
            )
              ctx.addIssue({
                code: "custom",
                path,
                message: "Field rules require module-workbook-field-rules-v1",
              });
            try {
              moduleWorkbookEditOrder(section);
            } catch {
              ctx.addIssue({
                code: "custom",
                path,
                message: "Workbook dependencies must be acyclic",
              });
            }
            const fields = new Map(
              section.columns.map((field) => [field.id, field]),
            );
            if (
              new Set(section.fieldRules?.map((rule) => rule.id)).size !==
              (section.fieldRules?.length ?? 0)
            )
              ctx.addIssue({
                code: "custom",
                path,
                message: "Duplicate field rule identity",
              });
            for (const rule of section.fieldRules ?? []) {
              if (
                new Set(rule.dependencies).size !== rule.dependencies.length ||
                rule.dependencies.some((id) => !fields.has(id)) ||
                rule.when.some(
                  (condition) => !rule.dependencies.includes(condition.field),
                ) ||
                Object.keys(rule.fields).some((id) => !fields.has(id))
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Field rules must declare their dependencies and known target fields",
                });
              for (const [id, options] of Object.entries(rule.fields)) {
                const field = fields.get(id);
                if (
                  (options.choices && field?.type !== "choice") ||
                  ((options.min !== undefined || options.max !== undefined) &&
                    field?.type !== "number") ||
                  (options.editor === "color" && field?.type !== "text") ||
                  (options.min ?? -Infinity) > (options.max ?? Infinity) ||
                  (options.choices &&
                    new Set(options.choices.map((choice) => choice.id)).size !==
                      options.choices.length)
                )
                  ctx.addIssue({
                    code: "custom",
                    path,
                    message:
                      "Conditional editor options must match the target field type and valid bounds",
                  });
              }
            }
            if (section.workbook?.groups)
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Declare expandable groups through the custom spreadsheet control",
              });
            if (
              Object.values(section.workbook?.columns ?? {}).some(
                (column) => column.duplicate,
              ) &&
              !features.includes("module-table-duplicate-policy-v1")
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Duplicate policies require module-table-duplicate-policy-v1",
              });
            if (section.dataset) {
              if (
                !features.includes("module-datasets-v1") ||
                datasetIds.has(section.dataset.id) ||
                moduleFieldsContainSecrets(section.columns)
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Shared datasets require module-datasets-v1, unique identities and public fields",
                });
              datasetIds.add(section.dataset.id);
            }
            if (section.source === "document") {
              const document = manifest.documents?.find(
                (item) => item.id === section.documentId,
              );
              if (
                !document ||
                !section.workbook ||
                document.defaultValue === null ||
                typeof document.defaultValue !== "object" ||
                Array.isArray(document.defaultValue)
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Document tables require a declared object document and native workbook controls",
                });
              else {
                try {
                  validateTableStorage(section, document.defaultValue);
                } catch {
                  ctx.addIssue({
                    code: "custom",
                    path,
                    message: "Invalid workbook document defaults",
                  });
                }
              }
            } else if (section.documentId)
              ctx.addIssue({
                code: "custom",
                path,
                message: "Only document tables declare documentId",
              });
            if (section.workbook) {
              if (
                !("requiredFeatures" in manifest.host) ||
                !manifest.host.requiredFeatures?.includes(
                  "module-table-workbook-v1",
                )
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Native workbook controls require module-table-workbook-v1",
                });
              const stateKey = section.workbook.stateKey;
              if (
                settings.has(stateKey) ||
                manifest.pages?.some((candidate) =>
                  candidate.sections.some(
                    (item) =>
                      item.type === "table" &&
                      (item.id === stateKey ||
                        (item !== section &&
                          item.workbook?.stateKey === stateKey)),
                  ),
                )
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Workbook state keys must be unique and separate from table and setting IDs",
                });
              for (const [id, options] of Object.entries(
                section.workbook.columns ?? {},
              )) {
                const field = section.columns.find((field) => field.id === id);
                if (
                  !field ||
                  (options.editor === "color" && field.type !== "text") ||
                  (options.duplicate &&
                    (section.source === "state" ||
                      section.computed?.columns.includes(id))) ||
                  (options.formula &&
                    (section.source === "state" ||
                      section.computed?.columns.includes(id) ||
                      !["text", "number", "boolean"].includes(field.type))) ||
                  (options.fill === "series" &&
                    !["text", "number"].includes(field.type))
                )
                  ctx.addIssue({
                    code: "custom",
                    path,
                    message:
                      "Workbook column options must match declared editable scalar columns",
                  });
              }
              if (
                (section.workbook.defaults?.frozenColumns ?? 0) >
                section.columns.length
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message: "Frozen column count exceeds the table width",
                });
            }
            if (
              section.live &&
              (section.source !== "document" ||
                !("requiredFeatures" in manifest.host) ||
                !manifest.host.requiredFeatures?.includes(
                  "module-table-live-v1",
                ) ||
                new Set(section.live.columns).size !==
                  section.live.columns.length ||
                section.live.columns.some(
                  (id) =>
                    !moduleTableInputColumns(section).some(
                      (field) => field.id === id,
                    ),
                ))
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Live table values require module-table-live-v1 and editable document columns",
              });
            if (section.rowHighlight || section.computed?.dependencies) {
              const dependencies = section.computed?.dependencies;
              if (
                !features.includes("module-table-presentation-v1") ||
                (section.rowHighlight &&
                  !section.columns.some(
                    (field) => field.id === section.rowHighlight?.field,
                  )) ||
                (dependencies &&
                  (new Set(dependencies.rowFields).size !==
                    dependencies.rowFields.length ||
                    new Set(dependencies.settingsFields).size !==
                      dependencies.settingsFields.length ||
                    dependencies.rowFields.some(
                      (id) =>
                        !moduleTableInputColumns(section).some(
                          (field) => field.id === id,
                        ),
                    )))
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Table presentation requires module-table-presentation-v1 and declared input/row fields",
                });
            }
            if (section.computed?.preview) {
              const preview = section.computed.preview;
              if (
                !("requiredFeatures" in manifest.host) ||
                !manifest.host.requiredFeatures?.includes(
                  "module-table-preview-v1",
                ) ||
                !manifest.exchange?.data.some(
                  (data) =>
                    data.id === preview.id &&
                    data.version === preview.version &&
                    data.query,
                )
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Table previews require module-table-preview-v1 and a declared read-only data query",
                });
            }
            if (
              section.autoNumber &&
              !moduleTableInputColumns(section).some(
                (field) =>
                  field.id === section.autoNumber &&
                  (field.type === "text" || field.type === "number"),
              )
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Automatic numbering must reference an editable text or numeric column",
              });
            if (section.computed || section.choiceDependencies) {
              if (
                section.source === "state" ||
                !("requiredFeatures" in manifest.host) ||
                !manifest.host.requiredFeatures?.includes(
                  "module-table-spreadsheet-v1",
                )
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Spreadsheet columns require an editable table and module-table-spreadsheet-v1",
                });
              const inputs = new Set(
                moduleTableInputColumns(section).map((field) => field.id),
              );
              if (
                section.computed &&
                (new Set(section.computed.columns).size !==
                  section.computed.columns.length ||
                  section.computed.columns.some(
                    (id) => !section.columns.some((field) => field.id === id),
                  ))
              )
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Computed columns must reference unique declared columns",
                });
              for (const [id, dependencies] of Object.entries(
                section.choiceDependencies ?? {},
              ))
                if (
                  !inputs.has(id) ||
                  new Set(dependencies).size !== dependencies.length ||
                  dependencies.some(
                    (dependency) =>
                      !inputs.has(dependency) || dependency === id,
                  )
                )
                  ctx.addIssue({
                    code: "custom",
                    path,
                    message:
                      "Choice dependencies must reference other editable columns",
                  });
            }
            if (
              section.selectionHighlight !== undefined &&
              (!("requiredFeatures" in manifest.host) ||
                !manifest.host.requiredFeatures?.includes(
                  "module-table-selection-v1",
                ))
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Table selection options require module-table-selection-v1",
              });
            const key = `${section.source}:${section.documentId ?? ""}:${section.id}`;
            if (
              tableIds.has(key) ||
              (section.source === "settings" && settings.has(section.id))
            )
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Table storage keys must be unique and separate from settings fields",
              });
            tableIds.add(key);
            if (moduleFieldsContainSecrets(section.columns))
              ctx.addIssue({
                code: "custom",
                path,
                message:
                  "Secret fields belong in settings forms, not spreadsheet cells",
              });
            if (section.source !== "state") {
              try {
                validateModuleFields(
                  moduleTableInputColumns(section),
                  Object.fromEntries(
                    section.columns.map((field) => [
                      field.id,
                      moduleFieldDefault(field),
                    ]),
                  ),
                );
              } catch {
                ctx.addIssue({
                  code: "custom",
                  path,
                  message:
                    "Editable table columns need valid defaults for new rows",
                });
              }
            }
          }
        });
      });
    }
  });

export const ModuleActionResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("success"),
    evidence: z.strictObject({
      kind: ModuleCompletionSchema,
      summary: DescriptionSchema,
    }),
  }),
  z.strictObject({
    status: z.literal("failure"),
    category: z.enum([
      "invalid-config",
      "unavailable",
      "timeout",
      "cancelled",
      "rejected",
      "internal",
    ]),
    message: DescriptionSchema,
    /** Stable integration-specific failure identity, retained by legacy adapters. */
    code: ModuleIdentifierSchema.optional(),
  }),
]);
export const ModuleFeedbackSchema = z
  .strictObject({
    id: ModuleIdentifierSchema,
    state: z.enum(["active", "inactive", "unavailable"]),
    observedAt: z.iso.datetime().nullable(),
    appearance: ModuleFeedbackAppearanceSchema.optional(),
    fields: z.record(z.string().max(96), z.json()).optional(),
  })
  .refine(
    (feedback) =>
      feedback.state === "unavailable" || feedback.observedAt !== null,
    "Known feedback needs an observation timestamp",
  );

export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;
export type ModuleActionResult = z.infer<typeof ModuleActionResultSchema>;
export type ModuleFeedback = z.infer<typeof ModuleFeedbackSchema>;
export type ModuleJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ModuleJsonValue[]
  | { readonly [key: string]: ModuleJsonValue };
export type ModuleValues = Readonly<Record<string, ModuleJsonValue>>;

export const ModuleStateSchema = z.strictObject({
  phase: z.enum(["starting", "connecting", "ready", "unavailable", "error"]),
  message: z.string().max(1_000).nullable(),
  observedAt: z.iso.datetime(),
  values: z.record(z.string().max(96), z.json()).default({}),
});
export type ModuleState = z.infer<typeof ModuleStateSchema>;
export function moduleFeedbackKey(
  id: string,
  fields: ModuleValues = {},
): string {
  const canonical = (value: ModuleJsonValue): ModuleJsonValue =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return JSON.stringify([id, canonical(fields)]);
}

export interface ModuleTrace {
  readonly level: "debug" | "info" | "error";
  readonly stage: string;
  readonly message: string;
  readonly error?: DiagnosticError;
}
export interface ModuleContext {
  /** Physical connection enablement. Available with module-disabled-state-v1; false permits local state only, never device I/O. */
  readonly connectionEnabled?: boolean;
  /** Local, instance-scoped runtime state across package versions. Never included in workspace exports. Access only after start. */
  readonly runtimeDirectory?: string;

  /** Module communication routed and authorized by Hubble. Requires module-exchange-v1. */
  readonly modules?: ModuleExchange;
  /** Requires host-service-registry-v1; available after start, with the same scope and origin grants as requestHost. */
  readonly services?: ModuleHostServices;
  readonly instanceId: string;
  readonly scope: ModuleInstanceScope;
  readonly settings: ModuleValues;
  /** Host adds package identity, generation and instance to every observation. */
  log(trace: ModuleTrace): void;
  publishFeedback(feedback: ModuleFeedback): void;
  publishState(state: ModuleState): void;
  /** Versioned service observations for host-owned views. Never a device command. */
  publishEvent?(channel: string, value: ModuleJsonValue): void;
  /** Declared host capabilities only; unavailable during prepare/migration. */
  requestHost?(
    method: string,
    value: ModuleJsonValue,
    signal?: AbortSignal,
  ): Promise<ModuleJsonValue>;
}
export interface ModuleExecutionContext {
  readonly executionId: string;
  readonly signal: AbortSignal;
  readonly gesture: (typeof MODULE_GESTURES)[number];
  readonly wrap: boolean;
  log(trace: ModuleTrace): void;
}
export interface ModuleInstance {
  /** Replace the observed feedback set without reconnecting. Observational: never issue controls here. */
  subscribeFeedback?(
    subscriptions: readonly ModuleFeedbackSubscription[],
    context: { readonly signal: AbortSignal },
  ): void | Promise<void>;

  /** Opt-in observational update. Return false without changing state when a restart is needed. */
  updateSettings?(
    settings: ModuleValues,
    context: { readonly signal: AbortSignal },
  ): boolean | Promise<boolean>;
  /** Read-only public data query. Never execute controls from this callback. */
  queryData?(
    query: ModuleDataQuery,
    context: { readonly signal: AbortSignal },
  ): Promise<ModuleJsonValue> | ModuleJsonValue;
  /** Connect/subscribe/observe only; never issue a control action on startup. */
  start(): Promise<void> | void;
  execute(
    actionId: string,
    fields: ModuleValues,
    context: ModuleExecutionContext,
  ): Promise<ModuleActionResult>;
  /** Dispose is idempotent and releases all owned resources, including failed starts. */
  dispose(): Promise<void> | void;
  /** Explicit service methods for host views and shared coordinators. */
  call?(
    method: string,
    value: ModuleJsonValue,
    context: Pick<ModuleExecutionContext, "signal" | "log">,
  ): Promise<ModuleJsonValue> | ModuleJsonValue;
  choices?(
    provider: string,
  ): readonly ModuleChoice[] | Promise<readonly ModuleChoice[]>;
  /** Read-only discovery. Draft values never become settings or execute a command. */
  discoverChoices?(
    query: ModuleChoiceQuery,
    context: { readonly signal: AbortSignal },
  ): ModuleChoicePage | Promise<ModuleChoicePage>;
}
export interface HubbleModule {
  /** Pure migration; no instance is created and host services are unavailable. */
  migrateDocument?(
    input: ModuleDocumentMigrationInput,
  ): ModuleJsonValue | Promise<ModuleJsonValue>;
  /** Pure migration of this instance's saved action/feedback expressions. Stable keys must remain unchanged. */
  migrateSavedActions?(
    actions: Readonly<ModuleSavedActions>,
    fromVersion: number,
    toVersion: number,
  ): ModuleSavedActions | Promise<ModuleSavedActions>;
  createInstance(context: ModuleContext): ModuleInstance;
  /** Pure data migration. No network calls or device commands; input is never mutated. */
  migrateConfig?(
    settings: ModuleValues,
    fromVersion: number,
    toVersion: number,
  ): Promise<ModuleValues> | ModuleValues;
}

/** The same validation applies to edits, migrations, selection and automatic updates. */
export function validateModuleSettings(
  manifest: ModuleManifest,
  values: ModuleValues,
): void {
  validateModuleFields(manifest.settings, values);
  for (const page of manifest.pages ?? [])
    for (const section of page.sections)
      if (section.type === "table" && section.source !== "document")
        validateTableStorage(section, values);
}

/** Document tables use the same field/layout contract as settings-backed workbooks. */
export function validateModuleDocument(
  manifest: ModuleManifest,
  id: string,
  value: ModuleJsonValue,
): void {
  ModuleDocumentValueSchema.parse(value);
  if (!manifest.documents?.some((item) => item.id === id))
    throw new Error("Undeclared module document");
  for (const section of manifest.pages?.flatMap((page) => page.sections) ??
    []) {
    if (
      section.type !== "table" ||
      section.source !== "document" ||
      section.documentId !== id
    )
      continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Workbook documents require an object");
    validateTableStorage(section, value as ModuleValues);
  }
}
function validateTableStorage(
  section: ModulePageTable,
  values: ModuleValues,
): void {
  if (section.workbook) {
    const view = moduleTableViewState(section.workbook, values);
    const ids = new Set(section.columns.map((field) => field.id));
    if (
      [
        ...view.columnOrder,
        ...view.hiddenColumns,
        ...Object.keys(view.columnWidths),
      ].some((id) => !ids.has(id)) ||
      view.frozenColumns > ids.size
    )
      throw new Error(`Invalid column layout in ${section.label}`);
  }
  if (section.source === "state" || values[section.id] === undefined) return;
  const rows = ModuleTableRowsSchema.parse(values[section.id]);
  if (rows.length > section.maxRows)
    throw new Error(`Too many rows in ${section.label}`);
  for (const row of rows) {
    validateModuleWorkbookRow(section, row.values);
    if (
      Object.keys(row.formulas ?? {}).some(
        (id) => !section.workbook?.columns?.[id]?.formula,
      )
    )
      throw new Error(`Undeclared formula column in ${section.label}`);
  }
}
