# Shared datasets and portable references

Candidate contract: API 1, `module-datasets-v1`, intended minimum Hubble 2.0.11.
Developer kit 1.5.0-dev.7 includes this contract. Installed Hubble 2.0.10 does not
provide it. Check the target host's features before activation.

## Ownership and scope

Hubble owns discovery, read authorization, stable identities, revisioned paging,
subscription cancellation and portable reference remapping. The package owns its
published table schema, computed values, source selection and how it uses data.
This service is read-only; it cannot write another module's document or execute
an action. A custom frontend calls its backend over the public page bridge; it
does not call private desktop messages.

Require `module-datasets-v1` and `host-service-registry-v1`, with `host.datasets`
for a consumer. Publish a table by adding `dataset: { id: 'labels', version: 1 }`.
Dataset IDs must be unique across the package's pages. Only declared table fields
are exposed; secret fields are prohibited. Private settings/document keys are
excluded. Settings, state and document tables use the same declaration.

The host currently publishes `button-matrix` with its stable base button columns,
resolved values, resolution errors, saved sheets and button IDs. Matrix action
columns and legacy CCC/router pages are not additional datasets in this candidate.
Modules publish their tables explicitly as those workflows are extracted. Do not
invent a private-message fallback for a source absent from the catalog.

The consumer can read its own instance's published tables. The operator separately
grants access to other modules' shared data and to shared Hubble data. Existing
module-data approval does not grant Hubble-data access. Revocation blocks pending
requests before the permission save finishes. Workspace/package/generation changes
invalidate the caller. Read approval does not grant action execution.

## Public client and failure handling

```ts
import { createModuleDatasetClient } from "@hubble/module-sdk";
const datasets = createModuleDatasetClient(context.services!);
const catalog = await datasets.list({ limit: 25 }, signal);
// Retain catalog.nextCursor for the next page; restart on a stale catalog.
const page = await datasets.read({ source, sheetId, limit: 64 }, signal);
// Pass page.dataset.revision and page.nextRowId on subsequent pages.
for await (const change of datasets.watch(source, lifetime.signal)) {
  // A changed descriptor signals a revision; read fresh rows when needed.
}
```

Use workspace, owner/instance, source, sheet, column and row IDs from responses.
Labels, indexes and array positions are not identities. Schema version changes,
deleted columns/rows/sheets, missing providers and denied access have explicit
unavailable results. A read with an old revision returns `stale`, never a mixture
of old and new pages. Do not substitute a neighboring row or another source.

Table values are committed snapshots. They do not expose an unsaved renderer
draft. Workbook formulas retain their saved resolved values; module-owned computed
output is accepted only for matching inputs. Unavailable computed values include
per-cell errors, which consumers must check instead of rendering null as success.
Backend code changing formula inputs must use a supported calculation path or
update its saved resolved values coherently; reading a dataset does not recalculate
a module document. This is distinct from Hubble's compiled Button Matrix source.

Watch uses bounded long polling, not a page session or a device subscription.
Abort one instance-lifetime controller on disposal. Handle unavailable results and
explicitly resubscribe after provider/permission recovery; do not busy-loop.
Catalog pages contain at most 100 sources; row pages at most 128 rows. Responses
are bounded to 192 KiB, source content to 16 MiB, sheets to 256, columns to 512 and
rows per sheet to 100,000. A cell/page that cannot fit returns a limit result.
At most 128 pending watches are accepted. Document/table limits may be smaller.

## Saved references and transfer

Use the reserved SDK reference shape inside a [portable document](documents.md):

```ts
const reference = ModuleDatasetReferenceSchema.parse({
  kind: "hubble-dataset-reference",
  formatVersion: 1,
  source: selected.source,
  schemaVersion: selected.version,
  sheetId,
  columnIds: [columnId],
  rowIds: [rowId],
});
const result = await datasets.readReference(reference, { limit: 1 }, signal);
```

Save through the document revision API after an explicit selection. Reference
reads validate the schema version and selected field/row IDs. For multiple pages,
pass the returned revision and next row ID to `readReference` as well. An unresolved
reference returns unavailable without querying a potentially unrelated source.

Workspace import remaps the workspace and mapped connection IDs in these tagged
objects. Sheet/column/row/source IDs remain stable. Duplicating a workspace remaps
its references to the copy. Missing connection mappings and foreign-workspace
references stay visible as unresolved; they are not redirected automatically.
Ordinary JSON strings and objects remain opaque. The reserved tag is validated
strictly; do not reuse it for unrelated module data. Full-workbook clipboard
contains table/layout data only, not a separate designer's source-link field.

The custom-canvas example includes a package-owned source picker, saves one exact
cell reference, composes the real host workbook, and uses the same reader for its
canvas and Matrix action. Qualify deleted sources, permission revocation, stale
pages, rename/reorder, non-default import/re-export and a package-only update.
Offline worker/browser evidence is separate from installed/native/device evidence.
