import {
  ModuleMatrixSchema,
  type ModuleFeedback,
  type ModuleValues,
} from "@hubble/module-sdk";
import type { MatrixObservation } from "@hubble/module-runtime-helpers/matrix";
import {
  LIVEGRADE_APPLICATIONS,
  LiveGradeApplicationSchema,
  liveGradeActionApplication,
  resolveLiveGradeSlotQuery,
} from "./config.js";
import type { ManagedLiveGradeConnectionSnapshot } from "./livegrade-connection-manager.js";
import { z } from "zod";

export const matrix = ModuleMatrixSchema.parse({
  id: "slots",
  label: "LiveGrade",
  actionId: "matrix",
  feedbackId: "matrix",
  primaryField: "slotId",
  inactiveWhen: [
    { field: "sequence", values: [null] },
    { field: "slotId", values: ["", null] },
  ],
  legacy: {
    adapter: "livegrade",
    connectionType: "livegrade",
    normalize: true,
  },
  variants: [
    {
      when: [{ field: "generation", values: [6] }],
      fields: { "module.application": { default: "6" } },
    },
    {
      when: [{ field: "edition", values: ["frontier"] }],
      fields: { "module.application": { default: "frontier" } },
    },
    ...LIVEGRADE_APPLICATIONS.map(({ value }) => ({
      when: [{ field: "column.commandId", values: [`select-slot-${value}`] }],
      fields: { "module.application": { default: value } },
    })),
  ],
  fields: [
    {
      fill: "copy",
      id: "enabled",
      label: "Enabled",
      type: "boolean",
      default: true,
      width: 88,
    },
    {
      fill: "copy",
      id: "module.application",
      label: "Application",
      type: "choice",
      default: "7",
      required: true,
      width: 240,
      choices: LIVEGRADE_APPLICATIONS,
    },
    {
      fill: "copy",
      id: "assignmentMode",
      label: "Assignment Mode",
      type: "choice",
      default: "auto-alphanumeric",
      width: 190,
      choices: [
        { value: "auto-alphanumeric", label: "Auto Alphanumeric" },
        { value: "manual", label: "Manual" },
      ],
    },
    {
      id: "sequence",
      label: "Menu Position",
      type: "number",
      default: null,
      min: 1,
      max: 4096,
      integer: true,
      formula: true,
      fill: "series",
      width: 150,
      rules: [
        {
          when: [{ field: "module.application", values: ["6", "pro6"] }],
          set: { max: 26 },
        },
      ],
    },
    {
      fill: "series",
      id: "slotId",
      label: "Slot / Query",
      type: "text",
      default: "",
      formula: true,
      width: 270,
      choiceProvider: "slots",
      choiceFields: ["slotId", "sequence", "assignmentMode"],
      emptyMessage:
        "Run the selected LiveGrade application and allow Hubble Accessibility access. You can also type a slot query.",
    },
  ],
});

export function liveGradeMatrixAction(
  fields: ModuleValues,
  settings: ModuleValues,
) {
  const values = z.record(z.string(), z.json()).parse(fields.values);
  const application = LiveGradeApplicationSchema.parse(
    values["module.application"] ??
      values.application ??
      liveGradeActionApplication("select-slot", {
        generation: settings.generation === 6 ? 6 : 7,
        edition: settings.edition === "frontier" ? "frontier" : "standard",
      }),
  );
  const assignmentMode = z
    .enum(["auto-alphanumeric", "manual"])
    .parse(values.assignmentMode ?? "auto-alphanumeric");
  let sequence =
    values.sequence === null || values.sequence === undefined
      ? null
      : z.int().min(1).max(4096).parse(values.sequence);
  let slotId = z
    .string()
    .max(256)
    .parse(values.slotId ?? "");
  if (application === "6" || application === "pro6") {
    const source = slotId.trim().toUpperCase();
    const letter = /^[A-Z]$/u.test(source) ? source.charCodeAt(0) - 64 : null;
    const numeric = /^\d+$/u.test(source) ? Number(source) : null;
    const candidate =
      letter ?? (assignmentMode === "auto-alphanumeric" ? numeric : null);
    if (
      (assignmentMode === "manual" && letter === null) ||
      (source && candidate === null) ||
      (sequence !== null && candidate !== null && sequence !== candidate)
    )
      throw new Error(
        "Choose one matching LiveGrade 6 slot letter and menu position",
      );
    sequence = z
      .int()
      .min(1)
      .max(26)
      .parse(sequence ?? candidate);
    slotId = String.fromCharCode(64 + sequence);
  }
  if (sequence === null && !slotId.trim())
    throw new Error("Choose a slot or enter a menu position");
  return {
    id: "livegrade.select-slot",
    fields: { application, assignmentMode, sequence, slotId },
  };
}

export function liveGradeMatrixFeedback({
  fields,
  settings,
  data,
}: MatrixObservation): Pick<
  ModuleFeedback,
  "state" | "observedAt" | "appearance"
> {
  const snapshot = (
    data.get("driver.snapshots") as
      | readonly ManagedLiveGradeConnectionSnapshot[]
      | undefined
  )?.[0];
  const action = liveGradeMatrixAction(fields, settings);
  const app = snapshot?.applications?.find(
    (item) => item.application === action.fields.application,
  );
  const resolved =
    app?.phase === "ready"
      ? resolveLiveGradeSlotQuery(
          app.slots,
          action.fields.slotId || String(action.fields.sequence),
        )
      : null;
  const slot = resolved?.kind === "resolved" ? resolved.slot : null;
  return {
    state: "inactive" as const,
    observedAt: new Date().toISOString(),
    // A menu catalog supplies a display label only; it does not prove selected state.
    appearance: {
      backgroundColor: null,
      glow: null,
      cells: slot
        ? {
            slotId: {
              label: `${slot.position} — ${slot.menuTitle}`.slice(0, 160),
              color: null,
            },
          }
        : {},
    },
  };
}
