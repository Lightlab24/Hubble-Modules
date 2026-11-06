import { z } from "zod";
import type { RouterGroupController } from "./group-controller.js";

export const GroupEditSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("add"),
    contextId: z.uuid(),
    id: z.uuid(),
    name: z.string().max(256),
  }),
  z.strictObject({
    operation: z.literal("rename"),
    contextId: z.uuid(),
    id: z.uuid(),
    name: z.string().max(256),
  }),
  z.strictObject({
    operation: z.literal("delete"),
    contextId: z.uuid(),
    id: z.uuid(),
  }),
  z.strictObject({
    operation: z.literal("automatic-take"),
    contextId: z.uuid(),
    enabled: z.boolean(),
  }),
]);
export type GroupEdit = z.infer<typeof GroupEditSchema>;
export const GroupPageSchema = z.object({
  contexts: z.array(z.object({ contextId: z.uuid(), name: z.string() })),
  contextId: z.uuid().nullable(),
  automaticTake: z.boolean(),
  groups: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type GroupPage = z.infer<typeof GroupPageSchema>;
export function groupPage(
  controller: RouterGroupController,
  contextId: string | null,
): GroupPage {
  const snapshot = controller.snapshot();
  const selected =
    snapshot.contexts.find((item) => item.reference.contextId === contextId) ??
    (contextId === null ? snapshot.contexts[0] : undefined);
  return {
    contexts: snapshot.contexts.map((item) => ({
      contextId: item.reference.contextId,
      name: item.name,
    })),
    contextId: selected?.reference.contextId ?? null,
    automaticTake: selected?.settings.automaticTake ?? true,
    groups:
      selected?.settings.groups.map((item) => ({
        id: item.id,
        name: item.name,
      })) ?? [],
  };
}

export async function editRouterGroups(
  controller: RouterGroupController,
  raw: unknown,
  signal: AbortSignal,
) {
  const input = GroupEditSchema.parse(raw);
  await controller.edit(
    input.contextId,
    (settings) => {
      switch (input.operation) {
        case "add":
          return {
            ...settings,
            groups: [...settings.groups, { id: input.id, name: input.name }],
          };
        case "rename":
          if (!settings.groups.some((item) => item.id === input.id))
            throw new Error("Routing group no longer exists");
          return {
            ...settings,
            groups: settings.groups.map((item) =>
              item.id === input.id ? { ...item, name: input.name } : item,
            ),
          };
        case "delete":
          if (!settings.groups.some((item) => item.id === input.id))
            throw new Error("Routing group no longer exists");
          return {
            ...settings,
            groups: settings.groups.filter((item) => item.id !== input.id),
          };
        case "automatic-take":
          return { ...settings, automaticTake: input.enabled };
      }
    },
    signal,
  );
  return groupPage(controller, input.contextId);
}
