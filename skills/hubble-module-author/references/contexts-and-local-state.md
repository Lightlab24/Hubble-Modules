# Logical contexts and local state (candidate API 1)

These additive contracts require Hubble 2.0.11 with the named features. They are
source candidates until the installed host advertises them. Kit versions do not
grant capabilities to an older app.

## Logical contexts

Require `module-contexts-v1`, `host-service-registry-v1` and capability
`host.contexts`. Use the scoped service:

```ts
const current = await context.services.request(
  "contexts",
  1,
  { method: "read" },
  signal,
);
const next = await context.services.request(
  "contexts",
  1,
  {
    method: "watch",
    afterRevision: current.revision,
  },
  signal,
);
```

The response contains a revision and at most 256 `{ reference, name }` aliases of
the calling physical connection. A watch waits up to 25 seconds; repeat with the
returned revision and cancel on disposal. Retry transient failures with bounded
backoff. Do not recreate a new watcher on every render or poll in a tight loop.
Names can change; the `contextId` is the identity.

`matrix.context: true` passes the owning logical `contextId` with Matrix execution,
feedback subscriptions and discovery drafts. Package-owned groups, automatic
behavior and other per-context settings belong in module documents. Hubble does
not interpret those workflow settings.

Persist the complete tagged `ModuleContextReference` in portable documents:
`{ kind: 'hubble-context-reference', formatVersion: 1, workspaceId, connectionId,
contextId, unresolved: false }`. Workspace transfer remaps workspace and physical
connection ownership while preserving the logical context ID. Missing or foreign
targets become unresolved; never guess a replacement or dispatch to one. Ordinary
strings and package-owned group IDs are opaque and are not rewritten.

## Keeping local editing available while a device is disabled

Connection packages may declare `lifecycle: { runWhenDisabled: true }` and require
`module-disabled-state-v1`. Hubble then starts the worker with
`context.connectionEnabled === false` while physical I/O is disabled. Enablement
changes replace that generation; restart/reload works in either mode. Packages
without the declaration retain stop-on-disable behavior. Workspace packages do
not use this flag.

In disabled mode, keep local documents, logical contexts, frontend editing and
local state decisions available. Do not instantiate a network client or issue
device commands. Explicit actions must distinguish local edits from device I/O
and reject the latter. The flag is a lifecycle contract, not an operating-system
network sandbox: a package remains responsible for its own sockets. Privileged
host services, helpers, resources and shared datasets remain unavailable while
the physical connection is disabled. Document/context access is scoped to the
same selected package and generation.

Matrix actions remain unavailable while disabled unless the package also declares
`matrix.availableWhenDisabled`, a nonempty list of conditions over declared row
fields. All conditions must match. For example,
`[{ field: 'actionType', values: ['toggle-local-state'] }]` keeps only that local
action available in Matrix and Advanced actions. This declaration requires
`lifecycle.runWhenDisabled` and `module-disabled-state-v1`. It does not enable
device commands. The package must still reject device I/O with
`context.connectionEnabled === false`. Test both allowed local actions and
blocked device actions through compilation and publication, not just direct
calls to the worker.

Use `createModuleHarness(module, settings, { connectionEnabled: false, services })`
to exercise the disabled path. Test initial startup, local edits, failed saves,
restart, disable/enable transitions, stale frontend sessions and removal/re-add.
Record the result independently from physical-device verification.
