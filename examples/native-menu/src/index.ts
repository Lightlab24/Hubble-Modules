import type { HubbleModule, NativeMenuResponse } from "@hubble/module-sdk";

// This fictional application profile is wholly package-owned. Replace it when
// authoring a real integration; no Hubble bundle or module-ID registry changes.
const target = {
  bundleId: "com.example.viewer",
  executableName: "Studio Viewer",
};
const root = [{ title: "View" }, { title: "Cameras" }];
export default {
  createInstance(context) {
    const services = context.services;
    if (!services) throw new Error("Native menu API is unavailable");
    return {
      start() {},
      dispose() {},
      async execute(id, fields, execution) {
        if (
          id !== "choose-view" ||
          typeof fields.title !== "string" ||
          !fields.title.trim()
        )
          return {
            status: "failure",
            category: "invalid-config",
            message: "Choose a view",
          };
        let cursor: string | undefined,
          application: NativeMenuResponse["application"] = null;
        const seen = new Set<string>(),
          items: NativeMenuResponse["items"] = [];
        for (let page = 0; page < 16; page++) {
          execution.signal.throwIfAborted();
          const result = await services.request(
            "native-menus",
            1,
            {
              method: "read",
              target,
              path: root,
              ...(cursor ? { cursor } : {}),
            },
            execution.signal,
          );
          if (
            !result.available ||
            !result.permissionGranted ||
            result.errorCode ||
            result.truncated ||
            !result.application
          )
            return {
              status: "failure",
              category: "unavailable",
              message: result.message ?? "Application menu is unavailable",
            };
          if (application && application.pid !== result.application.pid)
            return {
              status: "failure",
              category: "rejected",
              message: "Application restarted; refresh before selecting",
            };
          application = result.application;
          items.push(...result.items);
          if (items.length > 8000)
            throw new Error("Menu exceeds the package limit");
          if (result.nextCursor === null) {
            cursor = undefined;
            break;
          }
          if (seen.has(result.nextCursor))
            throw new Error("Repeated menu cursor");
          seen.add(result.nextCursor);
          cursor = result.nextCursor;
        }
        if (cursor || !application)
          return {
            status: "failure",
            category: "unavailable",
            message: "Menu discovery was incomplete",
          };
        const matching = items.filter(
          (item) =>
            item.path.length === root.length + 1 &&
            root.every((part, i) => part.title === item.path[i]?.title) &&
            item.path.at(-1)?.title === fields.title,
        );
        if (matching.length !== 1 || !matching[0]!.enabled)
          return {
            status: "failure",
            category: "invalid-config",
            message: "Choose one available menu command",
          };
        execution.signal.throwIfAborted();
        const result = await services.request(
          "native-menus",
          1,
          {
            method: "select",
            target,
            path: matching[0]!.path,
            preserveBackgroundFocus: true,
            expectedProcessId: application.pid,
          },
          execution.signal,
        );
        return result.completed
          ? {
              status: "success",
              evidence: {
                kind: "response",
                summary: "Native menu command completed",
              },
            }
          : {
              status: "failure",
              category: "rejected",
              message:
                result.message ??
                "Command did not complete; it will not be retried",
            };
      },
    };
  },
} satisfies HubbleModule;
