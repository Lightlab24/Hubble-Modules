# Custom module pages, shared data and Matrix composition

This reference records the required public extension model. The candidate
[custom page API](custom-pages.md) supplies packaged frontend sections and a
scoped backend bridge. The candidate [document API](documents.md) adds scoped
portable JSON documents. The candidate [dataset API](datasets.md) adds scoped
Hubble/module table discovery, reads, watches and portable source references.
These do not announce completed helper APIs or every module's extraction.
Check the actual host's feature
declarations and the corresponding SDK contracts before using a capability.
API 1 and existing declarative page/workbook contracts remain supported. Development
kit 1.5.0-dev.2 predates this clarification and does not supply the capabilities
listed as missing below.

## Ownership and independent delivery

A package must own its custom frontend, backend, domain logic, templates and any
supported helpers. Hubble owns the reusable container, shared Matrix engine,
permissions, storage/transfer guarantees and generic lifecycle services.

After the initial compatibility update, ordinary compatible changes to those
package-owned components must require only a new immutable module package. Page
registration, update, removal and restoration must be generic. Do not add a host
module ID, custom React screen, device enum, protocol parser or application profile
to make an integration work.

A custom page means bundled frontend code for bespoke interactions, such as a
designer or canvas. Declared settings, table, controls and status sections do not
by themselves satisfy that requirement. The frontend runs inside a host-owned
isolated container and communicates through a public scoped bridge. It does not
receive Hubble's preload, arbitrary IPC, private configuration objects or access
to the privileged renderer.

The page session must bind to workspace, instance, package identity and backend
generation. Updating, removing, disabling or changing workspace revokes old
sessions. Reopening a page or receiving state must not replay commands. Backend
commands, state, cancellation and errors must have a defined public contract.

## Shared data and documents

Custom frontends, module backends and Matrix actions must use the same public data
path and saved module documents. Do not maintain disconnected copies or depend on
desktop-only message names.

The required data contract includes:

- Discovery of Hubble and module datasets with stable workspace, owner/instance,
  source, sheet, column and row identities; labels and positions are not IDs.
- Versioned schemas, revisioned reads and bounded paging/subscriptions, including
  explicit stale, deleted and unavailable results.
- Scoped permissions and revocation on workspace, package or generation changes.
- Portable module documents with concurrency checks, history, migrations and
  explicit commands for edits. Other modules' private data is not directly writable.
- Non-default workspace/workbook transfer, replacement modes, reference retention,
  older versions and real-worker restart. Document/asset limits and exclusions
  must be explicit; runtime caches are not portable user storage.

## Use the actual Matrix implementation

Custom page composition must allow bespoke views alongside host-rendered Matrix
surfaces. The module declares schema, stable IDs, editor types, defaults, domain
rules, formula/fill policies and editable/computed restrictions. Do not copy the
grid, toolbar or interaction machinery into the package.

Qualification must cover the real shared toolbar/formula bar, dropdown dismissal,
colours, selection, context menus, row add/delete/duplicate/reorder, columns, sheets,
formulas, fill, clipboard, focus, keyboard/native dispatch and independent history.
Require immediate editing, unresolved saves, further edits, failure/dependency
rollback, stale receipts and feedback during typing. Preserve read-only and
computed-field restrictions. Native-menu simulation is not actual macOS acceptance.

The same package's action/feedback/discovery declarations must work in Button
Matrix and Advanced editors while using the same backend/data as its sidebar.

## Module-owned helpers

When a module needs native rendering, USB or another helper dependency, keep that
code in the module project. The required generic lifecycle must cover declared
platform/architecture support, immutable artifacts, verification, readiness,
cancellation, crash handling, diagnostics and coherent selection/update/rollback.
Do not require an unrelated manual replacement of an unversioned helper to finish
a module update. Do not copy printer/device/application implementation into Hubble.

## Current support versus required work

The source candidate adds a `custom` section, verified frontend assets and scoped
browser sessions. The public example composes a canvas with the host Matrix and
shares backend behavior with its Matrix action. It has passed offline worker and
full-renderer package replacement tests; installed qualification remains pending.
The dataset candidate provides the base Button Matrix and explicitly published
module tables; legacy CCC/router and Matrix action columns are not additional
datasets yet. The document candidate supplies revisioned JSON,
workspace transfer and native workbook composition. The helper candidate supplies
verified package distribution and Node/native process lifecycle on supported
POSIX hosts; see [helpers](helpers.md) for its limits. Large portable binary-asset
storage remains unimplemented. [Workspace instances](workspace-instances.md)
allow unknown workspace-wide packages without new host registration. Host Matrix
controls are shared; full per-module parity
and the complete lifecycle proof still require implementation/acceptance.

Until these contracts exist, identify the missing generic capability and continue
within supported APIs. A temporary separate designer must be reported as separate;
do not call it an integrated module-owned sidebar page. Do not publish manifests
that invent host feature names or SDK methods.

## Acceptance before claiming completion

Use a previously unknown module, built with only the public kit, that contains a
custom frontend, backend command, portable document, shared-data link, host-rendered
workbook and Matrix/Advanced actions. Exercise add/select, interaction and failure
cases, permissions, restart and transfer. Update both UI and backend behavior using
only a new package while full Hubble/HubDash file/link manifests remain identical.
Remove/re-add it and verify navigation/session cleanup and document retention.
Include helper lifecycle where applicable. Keep per-module acceptance inventories;
the generic fixture is additional proof, not a replacement for existing workflows.

Record exact artifacts and distinguish source, renderer, installed, native and
physical-device results. These requirements grant no permission to send device
commands or interrupt a protected live app.

A genuinely new OS privilege/platform primitive, an incompatible API change or a
bug in Hubble's shared Matrix engine can require a host update. Such limits must
be concrete and documented; they do not justify routine host rebuilds for module
features expressible by the supported extension model.
