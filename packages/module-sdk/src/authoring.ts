import {
  ModuleActionSchema,
  ModuleActionResultSchema,
  validateModuleFields,
  type ModuleManifest,
  type ModuleValues,
  type ModuleExecutionContext,
  type ModuleActionResult,
} from "./index.js";

/** Identity/version and the distribution allowlist are supplied by the build tool. */
export type ModuleManifestSource = Omit<
  ModuleManifest,
  "id" | "name" | "version" | "entry" | "files"
>;
export const defineModuleManifest = <T extends ModuleManifestSource>(
  manifest: T,
): T => manifest;
export type ActionHandler = (
  fields: ModuleValues,
  execution: ModuleExecutionContext,
) => ModuleActionResult | Promise<ModuleActionResult>;

/** A descriptor cannot be published without a matching handler, or silently dispatched elsewhere. */
export function createActionRegistry<
  const T extends readonly ModuleManifest["actions"][number][],
>(descriptors: T, handlers: Record<T[number]["id"], ActionHandler>) {
  const dispatch: Record<string, ActionHandler> = handlers;
  const actions = descriptors.map((descriptor) =>
    ModuleActionSchema.parse(descriptor),
  );
  const ids = new Set(actions.map((action) => action.id));
  if (
    ids.size !== actions.length ||
    Object.keys(handlers).length !== ids.size ||
    [...ids].some((id) => typeof dispatch[id] !== "function") ||
    Object.keys(handlers).some((id) => !ids.has(id))
  ) {
    throw new Error(
      "Action descriptors and handlers must have identical unique IDs",
    );
  }
  return {
    actions,
    async execute(
      id: string,
      fields: ModuleValues,
      execution: ModuleExecutionContext,
    ): Promise<ModuleActionResult> {
      const action = actions.find((item) => item.id === id);
      if (!action)
        return {
          status: "failure",
          category: "invalid-config",
          message: "Unknown module action",
        };
      if (execution.signal.aborted)
        return {
          status: "failure",
          category: "cancelled",
          message: "Cancelled before dispatch",
        };
      try {
        validateModuleFields(action.fields, fields);
      } catch {
        return {
          status: "failure",
          category: "invalid-config",
          message: "Invalid module action fields",
        };
      }
      const result = ModuleActionResultSchema.parse(
        await dispatch[id]!(fields, execution),
      );
      if (
        result.status === "success" &&
        ![action.completion, ...(action.completionAlternatives ?? [])].includes(
          result.evidence.kind,
        )
      )
        throw new Error(
          "Action completion evidence differs from its descriptor",
        );
      return result;
    },
  };
}
