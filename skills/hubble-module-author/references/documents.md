# Portable module documents

Candidate contract: API 1, `module-documents-v1`, intended minimum Hubble 2.0.11.
Developer kit 1.5.0-dev.10 adds package preparation and transactional migrations
to the original 1.5.0-dev.6 contract. Installed Hubble 2.0.10 does not
provide it. Check the target service's `describe` response before activation.

## Ownership and declaration

Hubble owns durable workspace storage, scope checks, revision arbitration,
transaction ordering and transfer. The package owns the JSON document's meaning,
defaults, validation and explicit version migrations. Do not put device-specific
state schemas or migrations in Hubble.

Require `module-documents-v1` and `host-service-registry-v1`, and declare the
`host.documents` capability. Declare each document in the manifest:

```ts
documents: [{
  id: 'design', label: 'Label design', version: 1,
  defaultValue: { title: 'Camera 1', labels: [], labelsView: { version: 1 } },
}],
```

A document belongs to the active workspace, module instance, module ID and stable
document ID. Connection instances have connection IDs; existing host scopes use
capability IDs. Labels and array positions are not identities. Other instances
cannot read or write it through this service. Removing a package/instance retains
saved documents for compatible re-addition under the same identity.

A first read returns the declared default with `revision: null` without writing
settings. Each committed change gets a new opaque revision. Reset stores the
current declared default. Undoing a first edit retains a non-null revision, so an
old creation request cannot overwrite the restored value.

## Public backend client

```ts
import {
  createModuleDocumentClient,
  ModuleDocumentConflictError,
} from "@hubble/module-sdk";

const documents = createModuleDocumentClient(context.services!);
const current = await documents.read("design", signal);
try {
  const saved = await documents.write(current, nextValue, signal);
} catch (error) {
  if (error instanceof ModuleDocumentConflictError) {
    // error.document is the current revision/value. Rebase disjoint edits only.
    // Preserve a conflicting user draft and ask the user to review it.
  } else throw error;
}
```

`list`, `read` and `watch` are observation operations. `write`, `reset` and
`history` are allowed from explicit page/backend calls and action execution;
startup, feedback and choice discovery cannot silently write or migrate data.
The host validates workspace, selected package, enabled instance and active worker
generation for every operation. A changed revision returns an explicit conflict;
a disk/validation/permission failure is an error, never an invitation to overwrite.

`documents.reset(current, signal)` restores the declared default.
`documents.history(current, 'undo' | 'redo', signal)` changes that document's
history only. History is session-local, up to 20 changes per document and bounded
globally; document values survive restart. Whole-document history uses revision
checks. The host workbook additionally maintains its own field-aware editing
history, preserving unrelated canvas edits. Neither history edits Button Matrix.

Subscribe using an instance-lifetime AbortController and abort on disposal. One
failure must not end the watch. Some hosts refuse a watch briefly right after a
version switch, with no feature to detect them, and other failures can happen on
any host. A loop that stops at its first error misses every later edit until its
worker restarts:

```ts
import { setTimeout as delay } from "node:timers/promises";

const watchDesign = async () => {
  let failures = 0;
  while (!lifetime.signal.aborted) {
    const opened = Date.now();
    try {
      for await (const snapshot of documents.watch("design", lifetime.signal)) {
        // Update confirmed state without replacing active text drafts or firing commands.
        // Clear any watch error you are showing.
      }
    } catch (error) {
      if (lifetime.signal.aborted) return;
      // A watch that stayed open was working, so this failure starts a new count.
      failures = Date.now() - opened > 5000 ? 1 : failures + 1;
      // Log every failure, and publish phase "error" from the second in a row.
      await delay(Math.min(5000, 250 * 2 ** (failures - 1)), undefined, {
        signal: lifetime.signal,
      }).catch(() => {});
    }
  }
};
const watching = watchDesign(); // On disposal: lifetime.abort(), then await this.
```

The client performs bounded long polls. Each `watch` call starts with a fresh read,
so a retry catches up on anything it missed. That read can succeed while the long
poll keeps failing, as it does at the host's limit on document subscriptions, so
a delivered snapshot clears the shown error but doesn't reset the count. The
`custom-spreadsheet` and `custom-canvas` examples test this loop in
`test/document-watch.test.ts`. Do not create a new watch loop for every render.
Worker state may publish a small public summary, but never expose credentials. A
custom frontend calls declared backend commands over `@hubble/module-sdk/frontend`;
it receives no private document/IPC escape hatch. Use the same document from
Matrix/Advanced action handlers.

## Host-rendered workbook in a document

A table can use `source: 'document'` and `documentId: 'design'`. Declare `workbook`
and its stable `stateKey` as for other native workbooks. The document must be an
object: rows are stored at the table ID and layout at the state key. Defaults and
writes must satisfy the declared table schema, row IDs, formula policies and
computed-field restrictions. The host validates those constraints on backend
writes too. It preserves unrelated keys in the document.

The real host Matrix surface handles immediate edits, typing, row operations,
formulas, sheets, clipboard and layout. Ordered saves rebase by stable row/field
identity; explicit revision conflicts can retry boundedly for disjoint changes.
Conflicting cell/layout changes fail visibly and keep correction drafts. Do not
rebuild the grid in the custom frontend. The `custom-canvas` example composes both
views and demonstrates backend retry only when an unrelated field changed.

## Versions and migrations

`version` describes the package's document schema, independently of its package
version and API 1. Existing data is read unchanged. With
`module-document-migrations-v1`, declare `migrate: true` and export the pure
`migrateDocument({ id, fromVersion, toVersion, value })` hook. Return the complete
new JSON value, preserving stable row IDs, saved layouts and unrelated keys. The
hook runs in an isolated worker before the replacement runtime starts, with no
instance or host-service access. It must not use hardware, network or filesystem
side effects. Test every supported source version; reject unsupported versions.

Package selection saves the document migration together with the binding,
settings and saved actions. A failed migration/save retains the previous data and
selection. The new runtime reads staged migrated documents during startup; they
are not committed early. Startup/import reconciles declared older documents before
starting their module. Opening a page does not perform a migration. A missing
ordinary document uses its default without writing. Document migrations are
independent of `migrateConfig` and `migrateSavedActions`.

A downgrade cannot overwrite a newer document. The recorded update rollback can
restore the preceding document only while its saved post-update values/revisions
are unchanged; later edits require a compatible package or an explicit workspace
restore. No automatic rollback discards those edits. Unexpected newer data that
an already-selected older descriptor encounters is read-only.

`legacyImport: 'ccc'` is a frozen compatibility input for the historical CCC owner,
not an extensibility mechanism for other packages. It calls the same pure hook
with `fromVersion: 0`. The host records `legacySource: 'ccc'` provenance, preserves
it on writes/history, and retains historical camera IDs during workspace transfer.
No module writes that record metadata through the document client. New modules
use ordinary documents and version migrations.

## Package validation and normalization

Require `module-document-preparation-v1` and `module-exchange-v1`; declare a query
in `exchange.data` and reference it with `prepare: { id, version }` on the document.
The package's read-only `queryData` receives:

```ts
{ id: 'prepare-list', version: 1, input: {
  id: 'list', version: 2, intent: 'write', // also reset, undo, redo
  before: { version: 2, value: previousValue }, value: proposedValue,
} }
```

Return `{ status: 'accepted', value }` or
`{ status: 'invalid', message, issues: [{ tableId, rowId, fieldId, message }] }`.
There are at most 128 issues; an empty list is allowed for a document-wide error.
The query cannot issue nested writes or device commands. Values still pass the
host's declared workbook/size checks. Hubble rechecks the active scope and revision
after awaiting preparation. Use this for domain validation, canonical text or
related-field normalization, without adding a module-specific host handler.

The UI applies the proposed edit immediately. Accepted normalization updates the
matching cells and their undo entry without discarding later edits. Invalid edits
remain local correction drafts and use the existing failure notification. Backend
clients receive `ModuleDocumentValidationError` with the message/issues. Disk,
permission and unexpected execution failures remain failures with rollback.
Undo/redo can be validated but must return the exact historical value; rewriting
history is rejected. Never treat an invalid response as a successful save.

See `examples/prepared-document` for a complete manifest, pure migration,
preparation query and tests. Verify rejection during a held save, a second edit,
unrelated-field preservation and normalized undo in the actual renderer.

## Transfer and limits

Workspace export/import/re-export preserves document values and versions. Import
remaps the owning connection ID with its workspace. Full-workbook clipboard copies
the declared table/layout, not unrelated canvas fields. Opaque JSON strings that
happen to contain connection IDs are not automatically rewritten. The candidate
[dataset API](datasets.md) defines explicit tagged source references that workspace
import/duplication remap while retaining stable sheet/column/row IDs.

Limits: 64 declarations per manifest; 256K JSON characters per value; 1,024 saved
records and 4M serialized characters per workspace. File/native assets and large
binary payloads are not document storage. They require a supported asset/helper
contract; do not silently omit user assets from export or use private disk paths.

Qualify non-default documents, layouts and formulas through new-workspace and
applicable replacement import modes, re-export and real-worker restart. Test
held saves, second edits, failure/dependent rollback, a refused watch, concurrent
canvas/workbook changes, package replacement/removal/re-addition and independent
histories.
Separate offline, installed, native-menu and physical-device evidence.
