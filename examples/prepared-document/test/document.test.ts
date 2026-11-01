import test from "node:test";
import assert from "node:assert/strict";
import { ModuleDocumentPreparationResultSchema } from "@hubble/module-sdk";
import { migrateDocument, prepareDocument } from "../src/index.js";

const old = {
  items: [{ id: "stable", values: { name: "  Camera A  ", enabled: true } }],
  itemsView: { version: 1, textSize: 18 },
  note: "Unknown keys survive",
};
test("upgrades only the declared document version and preserves identities, layout and unrelated keys", () => {
  const next = migrateDocument({
    id: "list",
    fromVersion: 1,
    toVersion: 2,
    value: old,
  });
  assert.deepEqual(next, {
    ...old,
    items: [{ id: "stable", values: { ...old.items[0]!.values, note: "" } }],
  });
  assert.equal(Object.hasOwn(old.items[0]!.values, "note"), false);
  assert.throws(() =>
    migrateDocument({ id: "list", fromVersion: 3, toVersion: 2, value: old }),
  );
});
test("prepares edits, reports cell issues, and never rewrites an undo value", () => {
  const request = {
    id: "list",
    version: 2,
    intent: "write",
    before: { version: 2, value: old },
    value: old,
  };
  const result = ModuleDocumentPreparationResultSchema.parse(
    prepareDocument(request),
  );
  assert.equal(result.status, "accepted");
  assert.deepEqual(result, {
    status: "accepted",
    value: {
      ...old,
      items: [
        { id: "stable", values: { ...old.items[0]!.values, name: "Camera A" } },
      ],
    },
  });
  assert.deepEqual(prepareDocument({ ...request, intent: "undo" }), {
    status: "accepted",
    value: old,
  });
  const invalid = ModuleDocumentPreparationResultSchema.parse(
    prepareDocument({
      ...request,
      value: {
        ...old,
        items: [{ id: "stable", values: { name: " ".repeat(81) } }],
      },
    }),
  );
  assert.equal(invalid.status, "invalid");
  if (invalid.status === "invalid")
    assert.deepEqual(invalid.issues[0], {
      tableId: "items",
      rowId: "stable",
      fieldId: "name",
      message: "Enter a name of up to 80 characters",
    });
});
