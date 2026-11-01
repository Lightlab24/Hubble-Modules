import { z } from "zod";
import { ButtonInteractionSchema } from "./button-interactions.js";
import {
  ActionColumnIdSchema,
  RgbHexSchema,
  SafeIdentifierSchema,
} from "./primitives.js";

export function normalizeCccIp(value: string): string {
  const ip = value
    .trim()
    .replace(/^\[|\]$/gu, "")
    .toLowerCase();
  if (z.ipv6().safeParse(ip).success)
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  return ip;
}

export const CccIpSchema = z
  .string()
  .transform(normalizeCccIp)
  .refine(
    (ip) =>
      ip === "" ||
      z.ipv4().safeParse(ip).success ||
      z.ipv6().safeParse(ip).success,
    "Enter an IPv4 or IPv6 address",
  );

export const CccRowSchema = z
  .strictObject({
    rowId: z.uuid(),
    enabled: z.boolean(),
    rcpIp: CccIpSchema,
    cameraNumber: z.int().min(1).max(999_999).nullable(),
  })
  .readonly();

export type CccRow = z.infer<typeof CccRowSchema>;

export function cccTargetKey(
  row: Pick<CccRow, "rcpIp" | "cameraNumber">,
): string | null {
  return row.rcpIp && row.cameraNumber !== null
    ? `${normalizeCccIp(row.rcpIp)}/${String(row.cameraNumber)}`
    : null;
}

export const CccRowsSchema = z
  .array(CccRowSchema)
  .max(512)
  .superRefine((rows, context) => {
    const ids = new Set<string>();
    const targets = new Set<string>();
    rows.forEach((row, index) => {
      const target = cccTargetKey(row);
      if (ids.has(row.rowId))
        context.addIssue({
          code: "custom",
          path: [index, "rowId"],
          message: "Duplicate CCC row ID",
        });
      if (target !== null && targets.has(target))
        context.addIssue({
          code: "custom",
          path: [index, "cameraNumber"],
          message: "This RCP and camera number already exist in CCC",
        });
      ids.add(row.rowId);
      if (target !== null) targets.add(target);
    });
  })
  .readonly();

export const CccConfigSchema = z
  .strictObject({
    revision: z.int().min(0),
    rows: CccRowsSchema,
    /** Older documents omit this field and retain independent camera toggles. */
    singleSwitch: z.boolean().optional(),
  })
  .superRefine((config, context) => {
    if (
      config.singleSwitch &&
      config.rows.filter((row) => row.enabled).length > 1
    )
      context.addIssue({
        code: "custom",
        path: ["rows"],
        message: "Single switch allows only one enabled camera",
      });
  })
  .readonly();
export type CccConfig = z.infer<typeof CccConfigSchema>;
export const EMPTY_CCC: CccConfig = Object.freeze({
  revision: 0,
  rows: Object.freeze([]),
});

export const CccCommandSchema = z.enum([
  "enable-camera",
  "disable-camera",
  "toggle-camera-enabled",
  "enable-all-cameras",
  "single-switch",
  "roll-enabled-cameras",
  "stop-enabled-cameras",
  "roll-toggle-enabled-cameras",
  "nd-up-enabled-cameras",
  "nd-down-enabled-cameras",
  "iso-up-enabled-cameras",
  "iso-down-enabled-cameras",
  "base-gain-up-enabled-cameras",
  "base-gain-down-enabled-cameras",
  "save-white-balance-preset-enabled-cameras",
]);
export type CccCommand = z.infer<typeof CccCommandSchema>;
/** Older saved one-way controls now share the camera toggle action. */
export function canonicalCccCommand(command: string): string {
  return command === "enable-camera" || command === "disable-camera"
    ? "toggle-camera-enabled"
    : command;
}
export const CCC_COMMAND_OPTIONS = Object.freeze([
  { value: "toggle-camera-enabled", label: "Enable / Disable Camera" },
  { value: "enable-all-cameras", label: "Enable / Disable All Cameras" },
  { value: "single-switch", label: "Single switch" },
  { value: "roll-enabled-cameras", label: "Start Recording" },
  { value: "stop-enabled-cameras", label: "Stop Recording" },
  { value: "roll-toggle-enabled-cameras", label: "Toggle Recording" },
  { value: "nd-up-enabled-cameras", label: "ND Up" },
  { value: "nd-down-enabled-cameras", label: "ND Down" },
  { value: "iso-up-enabled-cameras", label: "ISO Up" },
  { value: "iso-down-enabled-cameras", label: "ISO Down" },
  { value: "base-gain-up-enabled-cameras", label: "Base Gain Up" },
  { value: "base-gain-down-enabled-cameras", label: "Base Gain Down" },
  {
    value: "save-white-balance-preset-enabled-cameras",
    label: "Add preset (Sony VENICE)",
  },
] as const);
export const CCC_FEEDBACK_ACTIVE_COLOR = "#37A65B";
export const CCC_FEEDBACK_INACTIVE_COLOR = "#3A3A40";
export function cccCommandNeedsCamera(command: unknown): boolean {
  return (
    command === "enable-camera" ||
    command === "disable-camera" ||
    command === "toggle-camera-enabled"
  );
}

export function cccCommandControlsRecording(command: unknown): boolean {
  return (
    command === "roll-enabled-cameras" ||
    command === "stop-enabled-cameras" ||
    command === "roll-toggle-enabled-cameras"
  );
}

/** A number is a shortcut only when it identifies exactly one saved camera. */
export function resolveCccCameraRow(
  rows: readonly CccRow[],
  source: string,
): CccRow | null {
  const value = source.trim();
  if (!value) return null;
  const byId = rows.find((row) => row.rowId === value);
  if (byId) return byId;
  const matches = /^[1-9]\d{0,5}$/u.test(value)
    ? rows.filter((row) => row.cameraNumber === Number(value))
    : [];
  if (matches.length === 1) return matches[0] ?? null;
  throw new Error(
    matches.length > 1
      ? "This camera number exists on more than one RCP. Choose the camera from the list."
      : "Choose a camera from the CCC sheet, or enter its camera number.",
  );
}
export const CccMutationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("replace"),
    expectedRevision: z.int().min(0),
    rows: CccRowsSchema,
    singleSwitch: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("enabled"),
    rowId: z.uuid(),
    enabled: z.union([z.boolean(), z.literal("toggle")]),
  }),
  z.strictObject({ kind: z.literal("enable-all") }),
  z.strictObject({
    kind: z.literal("single-switch"),
    enabled: z.union([z.boolean(), z.literal("toggle")]),
  }),
]);
export type CccMutation = z.infer<typeof CccMutationSchema>;
export function applyCccMutation(
  current: CccConfig,
  mutation: CccMutation,
): CccConfig {
  if (
    mutation.kind === "replace" &&
    mutation.expectedRevision !== current.revision
  )
    throw new Error(
      "CCC changed in another control. Reload the sheet and try again.",
    );
  if (
    mutation.kind === "enabled" &&
    !current.rows.some((row) => row.rowId === mutation.rowId)
  )
    throw new Error("CCC camera row no longer exists");
  const singleSwitch =
    mutation.kind === "single-switch"
      ? mutation.enabled === "toggle"
        ? !current.singleSwitch
        : mutation.enabled
      : mutation.kind === "enable-all" && current.singleSwitch
        ? false
        : mutation.kind === "replace"
          ? (mutation.singleSwitch ?? current.singleSwitch)
          : current.singleSwitch;
  let rows =
    mutation.kind === "replace"
      ? mutation.rows
      : mutation.kind === "single-switch"
        ? current.rows
        : current.rows.map((row) => {
            if (mutation.kind === "enable-all")
              return cccTargetKey(row) === null
                ? row
                : { ...row, enabled: true };
            return row.rowId === mutation.rowId
              ? {
                  ...row,
                  enabled:
                    mutation.enabled === "toggle"
                      ? Boolean(singleSwitch) || !row.enabled
                      : mutation.enabled,
                }
              : row;
          });
  if (singleSwitch) {
    const previouslyEnabled = new Set(
      current.rows.filter((row) => row.enabled).map((row) => row.rowId),
    );
    const selected =
      (mutation.kind === "enabled" && mutation.enabled !== false
        ? mutation.rowId
        : undefined) ??
      [...rows]
        .reverse()
        .find((row) => row.enabled && !previouslyEnabled.has(row.rowId))
        ?.rowId ??
      rows.find((row) => row.enabled)?.rowId;
    rows = rows.map((row) => ({
      ...row,
      enabled: row.enabled && row.rowId === selected,
    }));
  }
  return CccConfigSchema.parse({
    revision: current.revision + 1,
    rows,
    ...(singleSwitch === undefined ? {} : { singleSwitch }),
  });
}

export const CccResultSchema = z
  .strictObject({
    rowId: z.uuid(),
    rcpIp: z.string(),
    cameraNumber: z.int().nullable(),
    phase: z.enum(["sent", "confirmed", "unconfirmed", "error"]),
    message: z.string().max(512),
  })
  .readonly();

export type CccResult = z.infer<typeof CccResultSchema>;

export const CccBatchResultSchema = z
  .strictObject({
    batchId: z.uuid(),
    command: CccCommandSchema,
    results: z.array(CccResultSchema).readonly(),
  })
  .readonly();

export type CccBatchResult = z.infer<typeof CccBatchResultSchema>;

export const CccRowLiveStateSchema = z
  .strictObject({
    rowId: z.uuid(),
    name: z.string(),
    connection: z.enum([
      "incomplete",
      "connecting",
      "online",
      "offline",
      "error",
    ]),
    recording: z.enum(["recording", "stopped", "unknown"]),
    message: z.string(),
    lastResult: CccResultSchema.nullable(),
  })
  .readonly();

export const CccStateSchema = z
  .strictObject({
    workspaceId: z.uuid(),
    config: CccConfigSchema,
    rows: z.array(CccRowLiveStateSchema).readonly(),
  })
  .readonly();

export type CccState = z.infer<typeof CccStateSchema>;

export const CccMutationRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  mutation: CccMutationSchema,
});

export const CccCommandRequestSchema = z.strictObject({
  workspaceId: z.uuid(),
  command: CccCommandSchema,
  rowId: z.uuid().optional(),
});

export type CccMutationRequest = z.infer<typeof CccMutationRequestSchema>;

export type CccCommandRequest = z.infer<typeof CccCommandRequestSchema>;

export const CccActionSchema = z
  .strictObject({
    type: z.literal("ccc.command"),
    actionId: SafeIdentifierSchema,
    actionColumnId: ActionColumnIdSchema,
    interaction: ButtonInteractionSchema,
    wrap: z.boolean().optional(),
    enabled: z.boolean(),
    command: CccCommandSchema,
    rowId: z.uuid().nullable(),
    drivesTally: z.boolean().default(true),
    feedbackColor: RgbHexSchema.prefault(CCC_FEEDBACK_ACTIVE_COLOR),
    feedbackInactiveColor: RgbHexSchema.nullable().prefault(
      CCC_FEEDBACK_INACTIVE_COLOR,
    ),
  })
  .readonly();
