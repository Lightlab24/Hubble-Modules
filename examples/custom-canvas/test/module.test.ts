import test from "node:test";
import assert from "node:assert/strict";
import {
  createModuleHostServices,
  ModuleDocumentRequestSchema,
  ModuleDocumentSnapshotSchema,
  ModuleDatasetRequestSchema,
  ModuleDatasetReferenceSchema,
  type ModuleState,
} from "@hubble/module-sdk";
import { randomUUID } from "node:crypto";
import manifest from "../src/manifest.js";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import module from "../src/index.js";
import { renderLabel } from "../src/render-label.js";

function harness() {
  const scope = {
    kind: "host" as const,
    workspaceId: randomUUID(),
    capabilityId: "example-custom-canvas",
  };
  let document = ModuleDocumentSnapshotSchema.parse({
    workspaceId: scope.workspaceId,
    owner: {
      kind: "host",
      capabilityId: scope.capabilityId,
      moduleId: "example-custom-canvas",
    },
    id: "design",
    version: 1,
    revision: null,
    value: manifest.documents![0]!.defaultValue,
    canUndo: false,
    canRedo: false,
  });
  const watchers = new Set<() => void>();
  const datasetRequests: unknown[] = [];
  let sourceText: string | null = "Linked label";
  const source = {
    workspaceId: scope.workspaceId,
    owner: { kind: "hubble" as const },
    sourceId: "button-matrix",
  };
  const services = createModuleHostServices(async (_method, raw, signal) => {
    signal?.throwIfAborted();
    if ((raw as { service: string }).service === "helpers") {
      const input = (raw as { input: { method: string; value?: unknown } })
        .input;
      return input.method === "call"
        ? { status: "result", value: renderLabel(input.value) }
        : {
            status: "helper",
            helperId: "renderer",
            state: "ready",
            message: null,
            pid: 123,
          };
    }
    if ((raw as { service: string }).service === "datasets") {
      const input = ModuleDatasetRequestSchema.parse(
        (raw as { input: unknown }).input,
      );
      datasetRequests.push(input);
      if (input.method !== "read")
        throw new Error("Unexpected dataset operation");
      if (sourceText === null)
        return { status: "unavailable", reason: "missing-row" };
      return {
        status: "data",
        sheetId: "sheet-1",
        nextRowId: null,
        dataset: {
          source,
          label: "Matrix",
          version: 1,
          revision: "a".repeat(64),
          available: true,
          sheets: [
            {
              id: "sheet-1",
              label: "Sheet 1",
              rowCount: 1,
              columns: [{ id: "buttonText2", label: "Text", type: "text" }],
            },
          ],
        },
        rows: [
          { id: "button-a", values: { buttonText2: sourceText }, errors: {} },
        ],
      };
    }
    const input = ModuleDocumentRequestSchema.parse(
      (raw as { input: unknown }).input,
    );
    if (input.method === "watch" && input.afterRevision === document.revision)
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          watchers.delete(wake);
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          watchers.delete(wake);
          reject(new Error("Cancelled"));
        };
        watchers.add(wake);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    if (input.method === "write") {
      assert.equal(input.expectedRevision, document.revision);
      document = {
        ...document,
        revision: randomUUID(),
        value: input.value,
        canUndo: true,
      };
      for (const wake of [...watchers]) wake();
    }
    return { status: "document", document };
  });
  return Object.assign(createModuleHarness(module, {}, { services, scope }), {
    source,
    datasetRequests,
    setSourceText(value: string | null) {
      sourceText = value;
    },
    document: () => document,
  });
}

test("sidebar and Matrix share module behavior while instances remain independent", async () => {
  const first = harness(),
    second = harness();
  const instance = first.instance;
  const count = () => (first.states.at(-1) as ModuleState).values.count;
  await instance.start();
  assert.equal(count(), 0);
  assert.deepEqual(
    await instance.call!(
      "page.designer",
      { sectionId: "canvas", commandId: "render", value: { text: "Camera 2" } },
      first.execution(),
    ),
    { text: "Preview: Camera 2", count: 1 },
  );
  const result = await instance.execute(
    "render",
    { values: { "module.text": "Matrix label" } },
    first.execution(),
  );
  assert.equal(result.status, "success");
  assert.equal(count(), 2);
  const saved = await instance.execute(
    "render",
    { values: {} },
    first.execution(),
  );
  assert.deepEqual(saved, {
    status: "success",
    evidence: { kind: "local", summary: "Preview: Camera 2" },
  });
  await second.instance.start();
  assert.equal((second.states.at(-1) as ModuleState).values.count, 0);
  await assert.rejects(
    async () =>
      instance.call!(
        "page.designer",
        { commandId: "render", value: { text: 123 } },
        first.execution(),
      ),
    /characters/,
  );
  const cancelled = await instance.execute(
    "render",
    { values: { "module.text": "Never" } },
    first.execution(AbortSignal.abort()),
  );
  assert.equal(cancelled.status, "failure");
  await instance.dispose();
  await instance.dispose();
  await second.instance.dispose();
});

test("sidebar and Matrix consume the same portable source link and fail when its row disappears", async () => {
  const h = harness();
  await h.instance.start();
  try {
    const reference = ModuleDatasetReferenceSchema.parse({
      kind: "hubble-dataset-reference",
      formatVersion: 1,
      source: h.source,
      schemaVersion: 1,
      sheetId: "sheet-1",
      columnIds: ["buttonText2"],
      rowIds: ["button-a"],
    });
    assert.deepEqual(
      await h.instance.call!(
        "page.designer",
        { commandId: "link-source", value: reference },
        h.execution(),
      ),
      { text: "Preview: Linked label", count: 1 },
    );
    assert.deepEqual(
      (h.document().value as Record<string, unknown>).sourceLink,
      reference,
    );
    h.setSourceText("After source edit");
    const preview = await h.instance.call!(
      "page.designer",
      { commandId: "preview-linked" },
      h.execution(),
    );
    assert.deepEqual(preview, { text: "Preview: After source edit", count: 2 });
    assert.deepEqual(
      await h.instance.execute(
        "render",
        { values: { "module.text": "" } },
        h.execution(),
      ),
      {
        status: "success",
        evidence: { kind: "local", summary: "Preview: After source edit" },
      },
    );
    assert.deepEqual(h.datasetRequests.at(-1), h.datasetRequests.at(-2));
    h.setSourceText(null);
    assert.deepEqual(
      await h.instance.execute("render", { values: {} }, h.execution()),
      {
        status: "failure",
        category: "invalid-config",
        message: "Linked data unavailable: missing-row",
      },
    );
    assert.deepEqual(
      (h.document().value as Record<string, unknown>).sourceLink,
      reference,
    );
  } finally {
    await h.instance.dispose();
  }
});
