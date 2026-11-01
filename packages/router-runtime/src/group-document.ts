import { z } from "zod";
import {
  ModuleContextReferenceSchema,
  type ModuleDocumentMigrationInput,
  type ModuleDocumentPreparationResult,
  type ModuleLogicalContext,
} from "@hubble/module-sdk";

const name = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value),
    "Enter a single-line group name",
  );
const group = z.object({ id: z.uuid(), name }).catchall(z.json());
export const RouterContextSettingsSchema = z
  .object({
    reference: ModuleContextReferenceSchema,
    automaticTake: z.boolean().default(false),
    groups: z.array(group).max(64).default([]),
    // Compatibility aliases preserve first/last-group behavior without rewriting other documents.
    groupAliases: z.record(z.string(), z.uuid().nullable()).default({}),
  })
  .catchall(z.json())
  .superRefine((context, issue) => {
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const item of context.groups) {
      if (ids.has(item.id))
        issue.addIssue({ code: "custom", message: "Group IDs must be unique" });
      if (names.has(item.name.toLocaleLowerCase("en-US")))
        issue.addIssue({
          code: "custom",
          message: "Group names must be unique",
        });
      ids.add(item.id);
      names.add(item.name.toLocaleLowerCase("en-US"));
    }
  });
export const RouterGroupDocumentSchema = z
  .object({
    contexts: z.array(RouterContextSettingsSchema).max(256).default([]),
  })
  .catchall(z.json())
  .superRefine((value, issue) => {
    const keys = value.contexts.map((item) => key(item.reference));
    if (new Set(keys).size !== keys.length)
      issue.addIssue({
        code: "custom",
        message: "Routing contexts must be unique",
      });
  });
export type RouterGroupDocument = z.infer<typeof RouterGroupDocumentSchema>;
export type RouterContextSettings = z.infer<typeof RouterContextSettingsSchema>;
export const routerContextKey = (
  reference: ModuleLogicalContext["reference"],
) =>
  JSON.stringify([
    reference.workspaceId,
    reference.connectionId,
    reference.contextId,
  ]);
const key = routerContextKey;

export function contextSettings(
  value: RouterGroupDocument,
  context: ModuleLogicalContext,
): RouterContextSettings {
  return (
    value.contexts.find(
      (item) =>
        !item.reference.unresolved &&
        key(item.reference) === key(context.reference),
    ) ?? RouterContextSettingsSchema.parse({ reference: context.reference })
  );
}

/** Keep every formerly blank/grouped action attached to the same workflow through first/last edits. */
export function normalizeRouterGroups(
  before: RouterGroupDocument,
  proposed: unknown,
): RouterGroupDocument {
  const result = RouterGroupDocumentSchema.parse(proposed);
  for (const context of result.contexts) {
    const previous =
      before.contexts.find(
        (item) => key(item.reference) === key(context.reference),
      ) ?? RouterContextSettingsSchema.parse({ reference: context.reference });
    context.groupAliases = { ...previous.groupAliases };
    const move = (from: string | null, to: string | null) => {
      for (const [alias, target] of Object.entries(context.groupAliases))
        if (target === from) context.groupAliases[alias] = to;
      context.groupAliases[from ?? ""] = to;
    };
    if (!previous.groups.length && context.groups.length)
      move(null, context.groups[0]!.id);
    else if (previous.groups.length === 1 && !context.groups.length)
      move(previous.groups[0]!.id, null);
  }
  return result;
}

export function resolveRouterGroup(
  context: RouterContextSettings,
  requested: string | null,
): string | null {
  const resolved = Object.hasOwn(context.groupAliases, requested ?? "")
    ? context.groupAliases[requested ?? ""]!
    : requested;
  if (!context.groups.length && resolved === null) return null;
  if (resolved !== null && context.groups.some((item) => item.id === resolved))
    return resolved;
  throw new Error("Choose an available routing group");
}

export function prepareRouterGroups(
  input: unknown,
): ModuleDocumentPreparationResult {
  const request = z
    .object({
      id: z.literal("routing-groups"),
      version: z.literal(1),
      value: z.json(),
      before: z.object({ version: z.literal(1), value: z.json() }),
      intent: z.enum(["write", "reset", "undo", "redo"]),
    })
    .parse(input);
  try {
    const value =
      request.intent === "undo" || request.intent === "redo"
        ? RouterGroupDocumentSchema.parse(request.value)
        : normalizeRouterGroups(
            RouterGroupDocumentSchema.parse(request.before.value),
            request.value,
          );
    return { status: "accepted", value };
  } catch (error) {
    return {
      status: "invalid",
      message:
        error instanceof z.ZodError
          ? error.issues[0]!.message
          : error instanceof Error
            ? error.message
            : "Check routing groups",
      issues: [],
    };
  }
}

export function migrateRouterGroups(
  input: ModuleDocumentMigrationInput,
): RouterGroupDocument {
  if (
    input.id !== "routing-groups" ||
    input.toVersion !== 1 ||
    input.fromVersion !== 0
  )
    throw new Error("Unsupported routing group document migration");
  const source = z
    .object({
      workspaceId: z.uuid(),
      connectionId: z.uuid(),
      contexts: z
        .array(
          z.object({
            contextId: z.uuid(),
            automaticTake: z.boolean(),
            groups: z.array(group).max(64),
          }),
        )
        .max(256),
    })
    .parse(input.value);
  return RouterGroupDocumentSchema.parse({
    contexts: source.contexts.map((context) => ({
      reference: {
        kind: "hubble-context-reference",
        formatVersion: 1,
        workspaceId: source.workspaceId,
        connectionId: source.connectionId,
        contextId: context.contextId,
      },
      automaticTake: context.automaticTake,
      groups: context.groups,
      groupAliases: {},
    })),
  });
}
