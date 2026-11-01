import { createHash } from "node:crypto";
import { KeyboardBridgeResponseSchema } from "@hubble/module-contracts/keyboard";
import type {
  ModuleChoice,
  ModuleChoiceQuery,
  ModuleChoicePage,
  ModuleHostServices,
} from "@hubble/module-sdk";

/** Application filtering and menu interpretation are package policy, not host UI rules. */
export function systemDiscovery(services: ModuleHostServices) {
  const catalogs = new Map<
    string,
    { revision: string; choices: ModuleChoice[] }
  >();
  return async (
    query: ModuleChoiceQuery,
    { signal }: { signal: AbortSignal },
  ): Promise<ModuleChoicePage> => {
    signal?.throwIfAborted();
    const bundle = String(query.draft.applicationBundleId ?? "");
    const includeInstalled =
      query.provider === "installed-applications" ||
      query.draft.actionType === "open-application";
    const key = JSON.stringify([
      query.provider,
      bundle,
      includeInstalled,
      query.search,
    ]);
    let catalog = catalogs.get(key);
    if (!query.cursor) {
      let choices: ModuleChoice[];
      if (
        query.provider === "applications" ||
        query.provider === "installed-applications"
      ) {
        const response = KeyboardBridgeResponseSchema.parse(
          await services.request(
            "keyboard",
            1,
            { operation: "list-applications" },
            signal,
          ),
        );
        if (!response.available)
          throw new Error(
            response.message ?? "Application discovery is unavailable",
          );
        const apps = [
          ...response.applications,
          ...(includeInstalled ? (response.installedApplications ?? []) : []),
        ];
        choices = [
          ...new Map(
            apps.map((app) => [
              app.bundleId,
              {
                id: app.bundleId,
                label: app.name.slice(0, 160),
                group: app.pid
                  ? "Running applications"
                  : "Installed applications",
              },
            ]),
          ).values(),
        ].filter((item) => item.id.length <= 160);
      } else if (query.provider === "menu-commands") {
        choices = [];
        if (bundle) {
          const seen = new Set<string>();
          let cursor: string | undefined;
          // Native snapshots are bounded to 8,000 items. Never silently present an incomplete catalog.
          for (let page = 0; page < 16; page++) {
            signal?.throwIfAborted();
            const response = KeyboardBridgeResponseSchema.parse(
              await services.request(
                "keyboard",
                1,
                {
                  operation: "list-menu-commands",
                  bundleId: bundle,
                  ...(cursor ? { cursor } : {}),
                },
                signal,
              ),
            );
            if (!response.available || response.errorCode)
              throw new Error(
                response.message ?? "Menu discovery is unavailable",
              );
            for (const command of response.menuCommands ?? []) {
              if (!command.enabled) continue;
              const source = JSON.stringify(command.path);
              if (source.length > 4096) continue;
              const id = createHash("sha256").update(source).digest("hex");
              if (seen.has(id)) continue;
              seen.add(id);
              choices.push({
                id,
                label: command.path
                  .map((part) => part.title)
                  .join(" > ")
                  .slice(0, 160),
                values: { menuPath: source },
              });
            }
            if (!response.menuCommandsNextCursor) {
              if (response.menuCommandsTruncated)
                throw new Error(
                  "Application menus exceeded the native catalog limit",
                );
              break;
            }
            if (cursor === response.menuCommandsNextCursor || page === 15)
              throw new Error("Application menu pagination did not complete");
            cursor = response.menuCommandsNextCursor;
          }
        }
      } else throw new Error("Unknown system choice provider");
      const search = query.search.toLocaleLowerCase();
      choices = choices.filter((item) =>
        `${item.label} ${item.id}`.toLocaleLowerCase().includes(search),
      );
      const revision = createHash("sha256")
        .update(JSON.stringify(choices))
        .digest("hex");
      catalog = { revision, choices };
      catalogs.set(key, catalog);
      while (catalogs.size > 16) catalogs.delete(catalogs.keys().next().value!);
    }
    if (
      !catalog ||
      (query.cursor && query.catalogRevision !== catalog.revision)
    )
      throw new Error("Application catalog changed; refresh choices");
    const offset = query.cursor === null ? 0 : Number(query.cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > catalog.choices.length
    )
      throw new Error("Invalid application choice cursor");
    const limit = Math.min(query.limit, 25);
    const choices = catalog.choices.slice(offset, offset + limit);
    const next = offset + choices.length;
    return {
      choices,
      revision: catalog.revision,
      nextCursor: next < catalog.choices.length ? String(next) : null,
    };
  };
}
