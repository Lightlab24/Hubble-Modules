---
name: hubble-module-author
description: Build, edit, validate, test, and package native Hubble modules with the matching developer kit. Use for Hubble integration authoring, not for Companion plugin development.
---

# Hubble module author

For integration extraction or independent module updates, read
[Hubble and module ownership](references/ownership.md). An external worker is not
proof that the integration's UI and logic are external. Hubble owns reusable
controls and platform services; the package owns declarations and device decisions.

For bespoke sidebar frontends, shared datasets/documents, host Matrix composition
or module-owned helpers, read [the extension model](references/extension-model.md).
Those requirements extend beyond the current declarative page API. Keep custom
frontend and helper code in the module project; do not move them into Hubble or
claim that a settings/table page supplies a custom frontend. The reference clearly
separates required capabilities from currently implemented support.
For package frontend implementation, read [custom pages](references/custom-pages.md).
For a package-owned screen that fills the app area, opt in with `pages[].layout: "full-page"`,
exactly one custom section, Hubble 2.0.18+ and `module-custom-pages-full-page-v1`.
The package owns its header, tabs, footer and scrolling; keep mixed/native pages in section mode.
See the kit 1.8.0 `full-page` example. Do not compensate with a fixed iframe height or host-specific screen.
For Button Matrix controls inside a custom layout, read
[the spreadsheet controls API](references/spreadsheet-controls.md) and build
the `custom-spreadsheet` example from the kit. For module-owned controls,
use the [spreadsheet styling and implementation guide](references/spreadsheet-styling.md).
Patch Sheet is the reference for
package-owned cell editing and an adjacent native workbook over one document.
Use the public browser bridge and packaged assets; keep the actual Matrix surface
in declared host-rendered workbook sections alongside the custom view.
For a slider, read [sliders](references/sliders.md): add a `slider` option to a number
field, or use `mountSlider` in a custom page. Both require `module-sliders-v1`.
For saved canvas/workbook/backend data, read [portable documents](references/documents.md).
Use the scoped document client and declared table sources; keep active drafts local
and use revision checks when reconciling multiple editors.
For package-owned validation or schema upgrades, declare document preparation and
pure migrations. Keep their feature requirements explicit; test atomic selection,
rollback after failure, invalid drafts and normalized undo with the public
`prepared-document` example. Domain validation must not move into a host screen.
For shared Hubble/module table discovery, reads, subscriptions and portable source
links, read [datasets](references/datasets.md). Use stable IDs and explicit read
grants; keep saved links in module documents and handle stale/unavailable results.
For package-owned Node/native processes, read [helpers](references/helpers.md).
Declare platforms, methods and limits; keep dependencies and device logic in the
package and test cancellation, crashes and generation cleanup.
For workspace-wide tools without device connections, read
[workspace instances](references/workspace-instances.md). Declare workspace scope
and keep the module ID stable; no new host enum or sidebar branch is required.
For logical connection aliases or editing while device I/O is disabled, read
[contexts and local state](references/contexts-and-local-state.md). Keep per-alias
workflow data in module documents and honor `context.connectionEnabled` before
creating a protocol client.

Read the developer kit’s `README.md` and `kit.json` first. SDK/tool release versions
are independent of module versions and API 1. Choose a supported API, minimum full
Hubble version and required host features; do not equate an SDK update with an app requirement. Use `service-client.mjs --url <operator-designated-origin> describe` to discover
the actual host capabilities, product, active workspace, storage paths, and exact
version selections. Choose an explicit operator-designated target. Do not default to Hubble2 or assume
that a running production app is available for activation or device tests. A source build or package import does not
activate code; apply/reload is explicit.

## Matrix action columns

For module-owned Matrix choices, per-row feedback colours/glow, discovery,
column settings and controls, read [the Matrix API](references/matrix.md).
Use the package's `matrix` descriptor and `subscribeFeedback` hook. Tally is an
implementation of these public APIs, not a host-owned editor. Prove a module-only
UI change against unchanged Hubble bytes before claiming independent updates.

For keyboard shortcuts, application/menu discovery and generic signed OS access,
read [native controls](references/native-controls.md), including the generic
`native-menus@1` API for exact executable/menu-root selection and focus monitoring. Keep target application
profiles and action interpretation in the package.

A page-oriented module with peer-only actions declares `actionUi: false` and
requires `module-action-authoring-v1` (Hubble 2.0.13+). Its actions remain callable
by authorized peers and existing saved documents; it is absent from new Matrix
and Advanced action pickers. Do not delete peer actions to hide a picker entry.
See the `sidebar-page` example. Omission preserves older packages’ behavior.
Mock is an inert test fixture, never an official module, installable project or
user action. Keep failure simulation under test fixtures and verify final release
bytes contain no Mock executor, module, activation bypass or picker entry.

## Native spreadsheet UI

For every module table, read [native workbooks](references/native-workbooks.md) before
writing its descriptor. Use `workbook` and a unique `stateKey` by default for editable
spreadsheets. Declare supported column editors, formulas, series and computed output;
Hubble owns the shared Button Matrix presentation and interaction controls.
A declared host feature proves descriptor support, not completed UI acceptance. Never recreate its grid,
dropdowns, color picker, clipboard, fill, sheets or save queue in module code.
Require the documented host features and verify them with `describe`. Qualify
non-default layout and formula data through workspace and full-workbook transfer.

Read [the contract guide](references/contract.md) when defining settings, actions,
feedback, or lifecycle behavior. Read [the workflow guide](references/workflows.md)
for tool invocation, package inspection, or handoff.

Create the multi-file TypeScript starter. Keep editable source in the user's chosen project folder. The suggested default
is `~/Documents/Hubble Modules/<module-id>/`. Installed packages will belong to the
service computer's product-specific storage; do not edit app bundles, registry
files, or SQLite to install one. Hubble module projects do not belong in Companion's
module directories.

Preserve stable module, action, feedback, and field IDs. Keep device-specific
features and completion semantics; a generic interface must not flatten protocol
differences. Document intentional migrations instead of silently changing saved
actions. Built-in protocols run in external workers while retaining their existing
clients and saved IDs. CCC and system actions use explicit workspace
host scopes; other integrations use physical-connection scopes.

Import/validation, activation/reload, and device-action testing are distinct.
Carry the user's authorization through the requested workflow without repetitive
approval prompts. A request to edit or install does not authorize commands to live
devices. Use simulation or an explicitly designated test device/workspace.

Report the concrete output path, module/version, tests run, and whether code was
merely packaged, installed, or actually activated. Do not equate device-offline
status with invalid code. Building a package does not submit or publish it.

For source organization, descriptor composition and release qualification, read
[the authoring guide](references/authoring.md). Official modules and reusable protocol
libraries live in the public Hubble-Modules repository. Build and test a module
there without a private Hubble checkout. A generated `module.mjs` may be large;
never move maintainable source back into it or hide a god file in a shared package.

## UI acceptance

Preserve each module's approved settings, actions, navigation, status and device
semantics when externalizing it. All spreadsheets use the host's shared Matrix
surface and active-editor command routing. Do not create a module-specific host
screen or branch on a module ID to restore a former UI. Identify a missing shared
capability explicitly and implement it generically through the appropriate host
change. Normal descriptor changes must work without rebuilding Hubble.

Record the host artifact digest, module archive digest, SDK/kit version and skill
revision. An app version number alone does not identify the tested implementation.
Run the same real-grid scenarios for Matrix and the module inside the application
renderer: selection, formulas, choices, fill, clipboard, menus, history, navigation,
feedback during typing, held saves, a second edit, rejection and unrelated-work
preservation. Include non-default workspace and workbook transfer. Mocked-grid
tests and isolated screenshots are supporting evidence, not UI-parity acceptance.

Keep every migrated module in the acceptance inventory until its applicable
checks pass. Identify whether it owns tables or uses Matrix's existing action
columns; test both legacy adapters and new generic actions where supported.
Do not invent a module page just to populate the checklist. State unavailable
hardware and packaged/native checks separately.
Carry the user's live-use constraints into every build, test and handoff; never
infer activation, restart or installation permission from a report or prepared
installer. Run offline fixtures in the existing checkout when live operation is
protected. A source-only handoff must say it has not been installed.
