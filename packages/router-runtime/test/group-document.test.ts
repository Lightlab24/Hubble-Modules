import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  contextSettings,
  migrateRouterGroups,
  normalizeRouterGroups,
  prepareRouterGroups,
  resolveRouterGroup,
} from "../src/group-document.js";

function prepare(input: { previous: unknown; value: unknown; reason: string }) {
  return prepareRouterGroups({
    id: "routing-groups",
    version: 1,
    before: { version: 1, value: input.previous },
    value: input.value,
    intent: input.reason === "history" ? "undo" : "write",
  });
}
function fixture() {
  const source = {
    workspaceId: randomUUID(),
    connectionId: randomUUID(),
    contexts: [{ contextId: randomUUID(), automaticTake: true, groups: [] }],
  };
  const value = migrateRouterGroups({
    id: "routing-groups",
    fromVersion: 0,
    toVersion: 1,
    value: source,
  });
  return { source, value };
}
it("imports stable aliases and group IDs without importing another device or changing defaults", () => {
  const { source } = fixture(),
    groupId = randomUUID();
  const value = migrateRouterGroups({
    id: "routing-groups",
    fromVersion: 0,
    toVersion: 1,
    value: {
      ...source,
      contexts: [
        { ...source.contexts[0], groups: [{ id: groupId, name: "Video" }] },
      ],
    },
  });
  expect(value.contexts[0]).toMatchObject({
    reference: {
      contextId: source.contexts[0]!.contextId,
      workspaceId: source.workspaceId,
      connectionId: source.connectionId,
    },
    automaticTake: true,
    groups: [{ id: groupId, name: "Video" }],
  });
  const next = contextSettings(value, {
    reference: { ...value.contexts[0]!.reference, contextId: randomUUID() },
    name: "New operator",
  });
  expect(next).toMatchObject({ automaticTake: true, groups: [] });
});
it("defaults a new routing context to Automatic Take while keeping every saved choice", () => {
  const { source } = fixture();
  const saved = migrateRouterGroups({
    id: "routing-groups",
    fromVersion: 0,
    toVersion: 1,
    value: {
      ...source,
      contexts: [{ ...source.contexts[0], automaticTake: false }],
    },
  });
  expect(saved.contexts[0]?.automaticTake).toBe(false);
  expect(
    contextSettings(saved, {
      reference: saved.contexts[0]!.reference,
      name: "Saved operator",
    }).automaticTake,
  ).toBe(false);
  // An edit to another field must not turn a saved choice back on.
  expect(
    normalizeRouterGroups(saved, {
      contexts: [
        { ...saved.contexts[0], groups: [{ id: randomUUID(), name: "Video" }] },
      ],
    }).contexts[0]?.automaticTake,
  ).toBe(false);
  // A context with no saved entry uses the current default.
  expect(
    contextSettings(
      { contexts: [] },
      { reference: saved.contexts[0]!.reference, name: "New operator" },
    ).automaticTake,
  ).toBe(true);
});
it("preserves blank/first/last group references and leaves deleted intermediate groups invalid", () => {
  const { value } = fixture(),
    first = randomUUID(),
    other = randomUUID(),
    newer = randomUUID();
  const edit = (before: typeof value, groups: { id: string; name: string }[]) =>
    normalizeRouterGroups(before, {
      contexts: [{ ...before.contexts[0], groups }],
    });
  const one = edit(value, [{ id: first, name: "Video" }]);
  expect(resolveRouterGroup(one.contexts[0]!, null)).toBe(first);
  const two = edit(one, [
    { id: first, name: "Video" },
    { id: other, name: "Audio" },
  ]);
  const remaining = edit(two, [{ id: other, name: "Audio" }]);
  expect(() => resolveRouterGroup(remaining.contexts[0]!, first)).toThrow(
    "available routing group",
  );
  expect(() => resolveRouterGroup(remaining.contexts[0]!, null)).toThrow(
    "available routing group",
  );
  const none = edit(remaining, []);
  expect(resolveRouterGroup(none.contexts[0]!, other)).toBeNull();
  const recreated = edit(none, [{ id: newer, name: "New group" }]);
  expect(resolveRouterGroup(recreated.contexts[0]!, other)).toBe(newer);
  expect(() => resolveRouterGroup(recreated.contexts[0]!, first)).toThrow();
});
it("rejects invalid/duplicate names while preserving unrelated fields and exact history values", () => {
  const { value } = fixture(),
    id = randomUUID();
  const proposed = {
    ...value,
    future: { retain: true },
    contexts: [{ ...value.contexts[0], groups: [{ id, name: "  Video  " }] }],
  };
  const prepared = prepare({
    previous: value,
    value: proposed,
    reason: "edit",
  });
  expect(prepared).toMatchObject({
    status: "accepted",
    value: {
      future: { retain: true },
      contexts: [{ groups: [{ id, name: "Video" }], groupAliases: { "": id } }],
    },
  });
  expect(
    prepare({
      previous: prepared.status === "accepted" ? prepared.value : null,
      value,
      reason: "history",
    }),
  ).toEqual({ status: "accepted", value });
  expect(
    prepare({
      previous: value,
      value: {
        contexts: [
          {
            ...value.contexts[0],
            groups: [
              { id, name: "Video" },
              { id: randomUUID(), name: "VIDEO" },
            ],
          },
        ],
      },
      reason: "edit",
    }),
  ).toMatchObject({ status: "invalid", message: "Group names must be unique" });
});
