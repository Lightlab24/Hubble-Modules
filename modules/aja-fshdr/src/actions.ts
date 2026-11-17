import { createActionRegistry } from "@hubble/module-sdk/authoring";
import { ModuleMatrixSchema, type ModuleExecutionContext, type ModuleManifest } from "@hubble/module-sdk";
import type { Values, WriteResult } from "./device.js";

export const ACTION = "set-hdr-transform";
export const MATCHES = "hdr-transform-matches";
export const TARGETS = "module.targets";
export const PROCESSOR = "module.processor";
export const TRANSFORM = "module.transform";
export const TARGET_CHOICES = "fshdr-targets";
export const transforms = [
  { id: "0", label: "Colorfront Engine-Live" },
  { id: "5", label: "Colorfront Engine-Film" },
  { id: "8", label: "Colorfront Engine-TV" },
  { id: "1", label: "BBC HLG LUT" },
  { id: "7", label: "NBCU LUT" },
  { id: "2", label: "User LUT" },
  { id: "3", label: "Dynamic LUT" },
  { id: "4", label: "Off" },
];

export const actions = [{
  id: ACTION,
  label: "Set HDR transform",
  description: "Set a processor's HDR transform and confirm the result on each unit",
  fields: [
    { id: "targets", label: "Addresses or all", type: "text", required: true, default: "" },
    { id: "processor", label: "Processor (0 = 4K/UHD)", type: "number", min: 0, max: 4, required: true, default: 1 },
    { id: "transform", label: "HDR transform", type: "choice", required: true, default: "3", choices: transforms },
  ],
  completion: "state-confirmed",
  timeoutMs: 25_000,
}] satisfies ModuleManifest["actions"];

export const matrix = ModuleMatrixSchema.parse({
  id: "fshdr-transform",
  label: "FS-HDR",
  actionId: ACTION,
  feedbackId: MATCHES,
  primaryField: TRANSFORM,
  inactiveWhen: [{ field: TARGETS, values: [""] }],
  fields: [
    {
      id: TARGETS, label: "FS-HDR Target", type: "text", default: "", required: true, width: 170,
      choiceProvider: TARGET_CHOICES, fill: "copy", formula: true,
    },
    {
      id: PROCESSOR, label: "Processor", type: "choice", default: "1", required: true, width: 100, fill: "copy",
      choices: [
        { value: "1", label: "Video 1" }, { value: "2", label: "Video 2" },
        { value: "3", label: "Video 3" }, { value: "4", label: "Video 4" },
        { value: "0", label: "4K/UHD" },
      ],
    },
    {
      id: TRANSFORM, label: "HDR Transform", type: "choice", default: "3", required: true, width: 170, fill: "copy",
      choices: transforms.map(({ id, label }) => ({ value: id, label })),
    },
  ],
});

export type Command = { targets: string[]; processor: number; transform: string };

export function readCommand(values: Values, isMatrix: boolean): Command | null {
  const targets = values[isMatrix ? TARGETS : "targets"];
  const processor = values[isMatrix ? PROCESSOR : "processor"];
  const transform = values[isMatrix ? TRANSFORM : "transform"];
  if (typeof targets !== "string" || !targets.trim() ||
      (typeof processor !== "string" && typeof processor !== "number") ||
      !/^[0-4]$/.test(String(processor)) || typeof transform !== "string" ||
      !transforms.some(({ id }) => id === transform)) return null;
  const list = targets.trim().split(/[\s,]+/);
  if (list.length > 16 || (list.length > 1 && list.includes("all"))) return null;
  return { targets: list, processor: Number(processor), transform };
}

export function createActions(
  apply: (command: Command, signal: AbortSignal) => Promise<WriteResult[]>,
) {
  const generic = createActionRegistry(actions, {
    [ACTION]: (fields, execution) => execute(readCommand(fields, false), execution),
  });

  async function execute(command: Command | null, execution: ModuleExecutionContext) {
    if (execution.signal.aborted) {
      return { status: "failure", category: "cancelled", message: "Cancelled before dispatch" } as const;
    }
    if (!command) {
      return { status: "failure", category: "invalid-config", message: "Choose a target, processor and transform" } as const;
    }
    const results = await apply(command, execution.signal);
    const confirmed = results.filter((result) => result.ok).length;
    if (confirmed < results.length) {
      return {
        status: "failure", category: "unavailable",
        message: confirmed + " of " + results.length + " confirmed. See Last completed command for each result.",
      } as const;
    }
    return { status: "success", evidence: { kind: "state-confirmed", summary: "Confirmed on " + confirmed + " FS-HDR(s)" } } as const;
  }

  return { generic, execute };
}
