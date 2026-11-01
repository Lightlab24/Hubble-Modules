# Native controls and shared action editors

Candidate host features for Hubble 2.0.11; API remains 1. Check the actual host's
`describe` response. These features do not ship in installed Hubble 2.0.10.

## Ownership

Hubble owns the signed native bridge, macOS Accessibility permission, bounded
request transport and generic application/keyboard/menu operations. Modules own
which applications to target, action choices, menu interpretation, validation,
discovery filters, labels and workflows. System Actions uses the same service that
an unrelated selected module can use. A module must not add a host screen or rely
on its module ID to obtain native access.

Declare `host.keyboard`, `host-service-registry-v1` and
`module-native-controls-v1`, then call `context.services.request('keyboard', 1,
input, signal)`. The selected, enabled instance must belong to the active
workspace. Connection modules lose access when disabled; keeping local state
running does not grant OS access. The service may be unavailable on the service
computer. Use the response's availability, permission and error fields.

Read operations are `list-applications` and `list-menu-commands`. Discovery and
feedback may use them. They must not activate applications, send keys or select
menus. Commands (`send-shortcut`, `activate-application`, `open-application` and
`select-menu-item`) require an explicit action execution or operator call. Native
calls are never automatically retried. Cancellation before dispatch prevents the
request; cancellation cannot undo an OS operation already performed.

`list-applications` returns running applications and an optional installed list.
The module decides whether a workflow accepts an installed application or requires
a running one. `list-menu-commands` takes a bundle ID and optional opaque cursor;
retain native menu path titles/identifiers exactly, follow pagination, and report
truncation or inaccessible menus. A catalogue read is not action completion.
A successful menu command/shortcut is response evidence; do not claim observed
selected state merely because the requested operation was accepted.

For existing immutable packages, the old System Actions `requestHost('keyboard')`
alias remains compatible. New modules use the typed registry, declared features,
and public SDK. The separate `native-menus@1` service below supplies exact
executable selection and background-focus monitoring without changing old keyboard
response schemas. Older LiveGrade packages retain their specialized compatibility
service; new packages must own their application profiles.

## Exact menu roots and background commands

Declare `host.native-menus`, `module-native-menus-v1` and
`host-service-registry-v1`. Call `services.request('native-menus', 1, input, signal)`.
The active selected/enabled instance receives the same generic grant regardless
of package ID. `read` is observational; `select` requires execution or an explicit
operator call. See the built-and-tested `examples/native-menu`.

```ts
const target = {
  bundleId: "com.example.viewer",
  executableName: "Studio Viewer",
};
const root = [{ title: "View" }, { title: "Cameras" }];
const result = await services.request(
  "native-menus",
  1,
  { method: "read", target, path: root },
  signal,
);
```

Hubble resolves a single running process using the bundle ID and optional actual
executable basename (case-insensitive). Ambiguous processes are rejected. It never
launches or activates an app, evaluates scripts, falls back to shortcuts, or
substitutes another edition. Paths are bounded to 12 exact title/identifier
segments. Raw title tabs, including native shortcut separators, are preserved;
packages may normalize display labels but must invoke the original path.

Read one declared root and follow `nextCursor` until null. A cursor is scoped to
the process and root, expires after 30 seconds and does not grant control. A page
contains at most 1000 commands and approximately 128 KiB; total inventory is
bounded to 8000 commands, 20000 nodes, 2 MiB and four seconds. `truncated` means
incomplete discovery, not merely another page. Fail incomplete, repeated-cursor,
changed-process or stale catalog results. Preserve disabled entries for display;
do not invoke them. Modules own slot numbering, filtering, limits and labels.

For a command, reread as needed and send its full exact current leaf path with
`expectedProcessId: result.application.pid` and `preserveBackgroundFocus: true`.
The process ID is a stale-read precondition, never a targeting override. Hubble
resolves the process again and rejects a restart, missing/ambiguous path or disabled
command. It performs at most one AXPress. If the target started in the background,
it monitors target activation and checks focus before dispatch and after a 300 ms
settling interval. It cannot reverse an OS action already dispatched. A focus
violation is failed evidence; never automatically replay a command after failure,
timeout or cancellation. The broker expires queued work after five seconds.

Keep cancellation checks before each read and dispatch, including after a package
queue wait. A successful `completed` result means native response evidence only;
it does not prove application-selected state. Permission and actual macOS focus
acceptance remain separate from injected offline native tests.

## Shortcut editing

Require `module-shortcut-editor-v1`. A Matrix text/choice key field, or a settings
or action form text/choice key field, can declare:

```ts
{ id: 'module.chord', label: 'Shortcut', type: 'text', default: '',
  required: true, shortcut: { modifiersField: 'module.modifiers' } }
{ id: 'module.modifiers', label: 'Modifiers', type: 'text', default: '',
  required: false }
```

The companion must be a unique sibling text field. Matrix fields cannot combine
this control with another discovery/parameter editor. Both Matrix cells open the
same shared typed/recorded shortcut control. Form composition displays the pair
once. Key codes (for example `KeyK`) and `+`-separated modifiers remain separate
stable saved fields; capture updates both in one undoable edit. Invalid text stays
editable, Escape cancels recording, and ordinary text undo stays local while
editing. Assign matching conditions to both fields and test an unresolved save,
a second edit and rejection. Modules still validate execution inputs.

## Workspace Matrix choices

Require `module-workspace-matrix-choices-v1` when a workspace package supplies
Matrix discovery. Declare the provider in the Matrix field and implement
`discoverChoices`; Hubble routes it using the workspace capability and selected
package digest. Do not invent a physical connection solely to populate choices.

For a complex source such as a menu path, return a short stable choice ID and the
full source in `values`, with the field in `choiceFields`. This uses
`module-choice-bindings-v1`; the selection is one atomic edit and closes the
ordinary picker. Manual drafts remain subject to module validation. Keep page
results bounded, preserve catalogue revision/cancellation, and reject stale
pagination. Publish friendly cell labels with Matrix feedback appearance while
retaining the original source for formulas, clipboard, editing and transfer.

Workspace Matrix declarations can retain optional logical connection contexts
with `context: true`, `workspaceContextTypes: ['keyboard']` (use the applicable
connection types), and `module-contexts-v1` plus `module-workspace-contexts-v1`.
The worker still belongs to the workspace. Hubble preserves the column's alias,
passes its stable `contextId`, and checks that the physical connection exists,
is enabled, and has a declared type at compilation and again at dispatch. Global
columns have no context. A context must never be silently cleared during legacy
normalization or transfer. This declaration does not grant workspace-wide reads
through the connection-scoped `host.contexts` service.

All feedback must pass `ModuleFeedbackSchema`, including display-only Matrix
labels. Locally known inactive rows need the time they were evaluated. Missing
device observations must remain `unavailable` with a null timestamp; never invent
active device evidence. Use `createModuleHarness` or validate every publication in
tests. A stub publisher that only records objects cannot prove worker acceptance.

## Acceptance

Use an unrelated package to prove permission checks and discovery/command
separation. Exercise the real shared grid and forms, shortcut capture/typing,
application and menu choices, dismissal, pending saves, feedback during typing,
atomic undo, rejection and non-default workspace transfer. Simulated native
responses prove transport and editor behavior; actual macOS permission, menu and
focus behavior require separate installed-app verification. Never direct an
automation test at the operator's live applications without authorization.
