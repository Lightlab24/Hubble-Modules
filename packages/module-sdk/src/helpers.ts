import { z } from "zod";
import type { ModuleHostServices } from "./host-services.js";

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u);
export const ModuleHelperValueSchema = z
  .json()
  .refine(
    (value) => JSON.stringify(value).length <= 131072,
    "Helper value exceeds 128K characters",
  );
export const ModuleHelperDefinitionSchema = z
  .strictObject({
    id: Id,
    label: z.string().min(1).max(160),
    variants: z
      .array(
        z.strictObject({
          platform: z.enum(["darwin", "linux", "win32"]),
          arch: z.enum(["arm64", "x64"]),
          runtime: z.enum(["node", "native"]),
          entry: z
            .string()
            .max(240)
            .regex(
              /^helpers\/(?:[A-Za-z0-9_@][A-Za-z0-9_.@+-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.+-]*$/u,
            ),
          nodeMajor: z.int().min(22).max(99).optional(),
        }),
      )
      .min(1)
      .max(6),
    methods: z
      .array(
        z.strictObject({
          id: Id,
          readOnly: z.boolean(),
          timeoutMs: z.int().min(100).max(120000).default(10000),
        }),
      )
      .min(1)
      .max(64),
    readinessTimeoutMs: z.int().min(100).max(30000).default(5000),
    maxConcurrent: z.int().min(1).max(16).default(1),
    memoryMb: z.int().min(64).max(1024).default(128),
  })
  .superRefine((helper, context) => {
    if (
      new Set(
        helper.variants.map((variant) => `${variant.platform}:${variant.arch}`),
      ).size !== helper.variants.length
    )
      context.addIssue({
        code: "custom",
        message: "Duplicate helper platform/architecture",
      });
    if (
      new Set(helper.methods.map((method) => method.id)).size !==
      helper.methods.length
    )
      context.addIssue({ code: "custom", message: "Duplicate helper method" });
    for (const variant of helper.variants) {
      if (
        variant.runtime === "node" &&
        (!variant.entry.endsWith(".mjs") || !variant.nodeMajor)
      )
        context.addIssue({
          code: "custom",
          message: "Node helpers require an ESM entry and explicit Node major",
        });
      if (variant.runtime === "native" && variant.nodeMajor !== undefined)
        context.addIssue({
          code: "custom",
          message: "Native helpers do not declare a Node major",
        });
    }
  });
export type ModuleHelperDefinition = z.infer<
  typeof ModuleHelperDefinitionSchema
>;
export const ModuleHelperRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("start"), helperId: Id }),
  z.strictObject({ method: z.literal("status"), helperId: Id }),
  z.strictObject({ method: z.literal("stop"), helperId: Id }),
  z.strictObject({
    method: z.literal("call"),
    helperId: Id,
    methodId: Id,
    value: ModuleHelperValueSchema,
  }),
]);
export const ModuleHelperStatusSchema = z.strictObject({
  status: z.literal("helper"),
  helperId: Id,
  state: z.enum(["stopped", "starting", "ready", "failed", "unavailable"]),
  message: z.string().max(1000).nullable(),
  pid: z.int().positive().nullable(),
});
export const ModuleHelperResponseSchema = z.union([
  ModuleHelperStatusSchema,
  z.strictObject({
    status: z.literal("result"),
    value: ModuleHelperValueSchema,
  }),
]);
/** Newline-delimited UTF-8 JSON on stdin/stdout; stdout is reserved for this protocol. */
export const ModuleHelperInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("call"),
    id: z.uuid(),
    methodId: Id,
    value: ModuleHelperValueSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), id: z.uuid() }),
]);
export const ModuleHelperOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), protocolVersion: z.literal(1) }),
  z.strictObject({
    type: z.literal("result"),
    id: z.uuid(),
    value: ModuleHelperValueSchema,
  }),
  z.strictObject({
    type: z.literal("error"),
    id: z.uuid(),
    message: z.string().max(1000),
  }),
  z.strictObject({ type: z.literal("cancelled"), id: z.uuid() }),
]);
export type ModuleHelperRequest = z.infer<typeof ModuleHelperRequestSchema>;
export type ModuleHelperStatus = z.infer<typeof ModuleHelperStatusSchema>;
export type ModuleHelperResponse = z.infer<typeof ModuleHelperResponseSchema>;
export function createModuleHelperClient(
  services: ModuleHostServices,
  helperId: string,
) {
  return {
    start: (signal?: AbortSignal) =>
      services.request("helpers", 1, { method: "start", helperId }, signal),
    status: (signal?: AbortSignal) =>
      services.request("helpers", 1, { method: "status", helperId }, signal),
    stop: (signal?: AbortSignal) =>
      services.request("helpers", 1, { method: "stop", helperId }, signal),
    async call(
      methodId: string,
      value: z.infer<typeof ModuleHelperValueSchema>,
      signal?: AbortSignal,
    ) {
      const result = await services.request(
        "helpers",
        1,
        { method: "call", helperId, methodId, value },
        signal,
      );
      if (result.status !== "result")
        throw new Error(result.message ?? "Helper did not return a result");
      return result.value;
    },
  };
}
