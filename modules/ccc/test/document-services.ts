import { randomUUID } from "node:crypto";
import {
  createModuleHostServices,
  ModuleDocumentRequestSchema,
  type ModuleDocumentSnapshot,
} from "@hubble/module-sdk";
import {
  cccDocumentConfig,
  migrateCccDocument,
  prepareCccDocument,
} from "../src/document.js";
import type { CccConfig } from "../src/config.js";

/** Inert workspace store for protocol tests; does not use a Hubble process or database. */
export function documentServices(
  workspaceId: string,
  initial: CccConfig,
  changed: (config: CccConfig) => void,
  beforeWrite?: () => Promise<void>,
  beforeRequest?: (method: string) => void | Promise<void>,
) {
  let document: ModuleDocumentSnapshot = {
    workspaceId,
    owner: { kind: "host", capabilityId: "ccc", moduleId: "hubble-ccc" },
    id: "cameras",
    version: 1,
    revision: randomUUID(),
    value: JSON.parse(
      JSON.stringify(
        migrateCccDocument({
          id: "cameras",
          fromVersion: 0,
          toVersion: 1,
          value: JSON.parse(JSON.stringify(initial)),
        }),
      ),
    ),
    canUndo: false,
    canRedo: false,
  };
  const watchers = new Set<() => void>();
  return createModuleHostServices(async (method, value, signal) => {
    if (
      method !== "service" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("input" in value) ||
      value.service !== "documents"
    )
      throw Error("Unexpected host service");
    const input = ModuleDocumentRequestSchema.parse(value.input);
    await beforeRequest?.(input.method);
    if (input.method === "watch" && document.revision === input.afterRevision)
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          watchers.delete(done);
          signal?.removeEventListener("abort", abort);
        };
        const done = () => {
          finish();
          resolve();
        };
        const abort = () => {
          finish();
          reject(Error("Cancelled"));
        };
        watchers.add(done);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    if (input.method === "write") {
      await beforeWrite?.();
      if (input.expectedRevision !== document.revision)
        return { status: "conflict", document };
      document = {
        ...document,
        revision: randomUUID(),
        value: JSON.parse(
          JSON.stringify(
            prepareCccDocument({
              id: "cameras",
              version: 1,
              intent: "write",
              before: { version: 1, value: document.value },
              value: input.value,
            }),
          ),
        ),
      };
      changed(cccDocumentConfig(document.value));
      for (const listener of [...watchers]) listener();
    }
    return { status: "document", document };
  });
}
