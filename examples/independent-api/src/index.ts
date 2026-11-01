import type { HubbleModule } from "@hubble/module-sdk";
export default {
  migrateSavedActions(actions, from, to) {
    if (from !== 1 || to !== 2) throw new Error("Unsupported migration");
    return actions.map((item) => ({
      ...item,
      actionId:
        item.actionId.mode === "literal" && item.actionId.source === "set-state"
          ? { mode: "literal", source: "set-active" }
          : item.actionId,
    }));
  },
  createInstance(context) {
    let active = false,
      disposed = false;
    const publish = () => {
      const observedAt = new Date().toISOString();
      context.publishState({
        phase: "ready",
        message: null,
        observedAt,
        values: { active },
      });
      context.publishFeedback({
        id: "active",
        state: active ? "active" : "inactive",
        observedAt,
      });
    };
    return {
      async start() {
        await context.services?.describe();
        publish();
      },
      async execute(id, fields, execution) {
        if (execution.signal.aborted || disposed)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled",
          };
        if (id !== "set-active" || typeof fields.active !== "boolean")
          return {
            status: "failure",
            category: "invalid-config",
            message: "Invalid local action",
          };
        active = fields.active;
        publish();
        return {
          status: "success",
          evidence: { kind: "local", summary: "Local state updated" },
        };
      },
      async discoverChoices(query, { signal }) {
        if (signal.aborted || disposed) throw new Error("Cancelled");
        if (query.provider !== "sources") throw new Error("Unknown provider");
        const region = query.draft.region === "stage" ? "stage" : "studio";
        const revision = `${region}-1`;
        if (query.cursor && query.catalogRevision !== revision)
          throw new Error("Catalog changed");
        const choices = Array.from({ length: 24 }, (_, index) => ({
          id: `${region}-${index + 1}`,
          label: `${region} source ${index + 1}`,
          group: region,
        })).filter(({ label }) =>
          label.toLowerCase().includes(query.search.toLowerCase()),
        );
        const offset = Number(query.cursor ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("Invalid cursor");
        const end = offset + query.limit;
        return {
          revision,
          choices: choices.slice(offset, end),
          nextCursor: end < choices.length ? String(end) : null,
        };
      },
      async dispose() {
        disposed = true;
      },
    };
  },
} satisfies HubbleModule;
