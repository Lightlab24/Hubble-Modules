# Module-owned Matrix columns (API 1)

Require Hubble 2.0.10 and `module-matrix-v1` plus
`module-feedback-observers-v1`. These are additive API 1 features. A host upgrade
is needed once to supply these generic capabilities. Subsequent changes to a
module's choices, fields, rules, labels or presentation ship in that module.

Declare `manifest.matrix`; do not add a module-specific React component, device
name check, receiver or feedback rule to Hubble. See the kit's
`examples/matrix-feedback` for an independent, non-device example.

## Columns and editing

The descriptor names an `actionId`, `feedbackId`, `primaryField` and `fields`.
Declare the action and feedback IDs in the manifest as well. New custom field IDs
use `module.<name>`; `enabled` and `actionType` are shared reserved names. Preserve
field identities across updates: they identify saved sources, formulas and layout.
The SDK validates this namespace and the existing legacy field IDs. Host-generated
Connection, Status and Last Result columns cannot be redeclared as editable fields.
The verified descriptor travels with the package binding for offline editing and
workspace transfer. A descriptor is limited to 64 KiB and the complete binding to
270,336 characters, including settings.

Up to 32 module fields are supported. The host supplies its shared Enabled control when omitted; a declared `enabled` field must be boolean.

Fields declare type, default, validation, `formula`, `fill: 'copy' | 'series'`,
visibility and `enabledWhen`. Disabled fields retain their draft source but are
passed to execution as null. `variants` overlay field constraints from connection
settings. `inactiveWhen` leaves a row unconfigured; `observerWhen` publishes its
feedback without adding a button-press command. `choice: true` conditions match
the base choice independently of its parameters.

Declare `fill` explicitly for every editable Matrix field. Use `copy` for IDs,
choices, colours and shared settings; use `series` for sequential addresses,
camera/feed/slot numbers and numbered labels. Numeric type alone is not a policy:
a timeout or duration often needs copying. The compatible default remains `copy`.

SDK 1.7.0 and Hubble 2.0.15 add `module-matrix-fill-rules-v1`. A field whose
meaning changes by action can override `fill` in its existing `rules[].set`:

```ts
{ id: 'module.value', label: 'Value', type: 'number', default: 1, fill: 'copy',
  rules: [{ when: [{ field: 'actionType', values: ['select-slot'] }],
    set: { fill: 'series' } }] }
```

Require `module-matrix-row-fields-v1` and `module-matrix-fill-rules-v1` for this
declaration. The host resolves the rule from current row inputs, including pending
edits. A fill lane spanning different copy/increment rules is rejected without
changing cells; independent columns may have different policies. Formula sources
still translate relative references under either policy. Keep ordered selections
and opaque references on `copy`; do not accidentally increment part of a list.
Test changed actions, held saves, incompatible rows and subsequent edits. These
decisions remain in the package; no integration-name branch belongs in Hubble.

Keep fields required when execution needs them. In Hubble 2.0.11's shared
compiler, a blank or whitespace-only literal in an enabled required field is an
incomplete-configuration warning: its source remains editable and no action is
published, including an older valid action. Nonblank invalid values and formula
errors retain their validation errors. Do not make a required execution input
optional merely to hide a red cell. Use `inactiveWhen` when the module's workflow
intentionally treats an empty selection as an unconfigured row. Test blank,
invalid, disabled and valid rows independently, including a second edit after a
failure. Module validation or execution failure must not lock the workbook;
report any host editing lock separately from a device or field warning.

With `module-matrix-choice-presentation-v1`, static `fields[].choices` can supply
fallback labels and optional `textColor: '#RRGGBB'`, including text fields that
also use `choiceProvider`. Hubble renders these labels and exact text colors
without waiting for feedback or a device connection. A current observation may
supply a richer label; it does not erase the declared text color. These are
presentation values, never replacement source values or execution feedback.
Require the feature explicitly. Older hosts do not support choice text colors.

With `module-matrix-field-presentation-v1`, a field can declare
`textColor: '#RRGGBB'` directly or through `rules[].set.textColor`. This colors
numeric, manual and formula-derived values even while the device is offline or a
save is pending. The host resolves the rule from current row inputs. A declared
choice's `textColor` takes precedence over the field color. Observation labels
and background feedback remain independent; no live observation is required.
Require this feature explicitly, including when a color is supplied by a variant.
This affects presentation only and never changes saved values or device state.

`choiceEditor` supplies choices and optional boolean/colour-pair parameters.
Parameterized choices stay open until Apply; ordinary choices commit and close.
Parameters may have `enabledWhen` rules. Use `decodeModuleChoice` and
`encodeModuleChoice` rather than inventing a second source codec. `explicit`
distinguishes untouched plain sources from edited preferences. Aliases and
`preserveParameters` support old saved values without rewriting them.

### Editable input and resolved presentation (SDK 1.5.0)

Keep the user's literal or formula as the saved source. Resolve a camera number,
address or other reference inside the module; do not replace it with a UUID merely
because discovery found a matching device. With `module-choice-bindings-v1`, return
the editable value in a choice's `values[fieldId]`; its `id` may still identify the
discovered record. Declare `fill: 'series'` for incrementing addresses or numbered
names and `fill: 'copy'` for shared settings. Missing fill declarations default to
copy. A display label is never a fill seed.

Hubble 2.0.12 adds `module-matrix-input-source-v1`. Require that feature before
publishing `appearance.cells[fieldId].inputSource` (a string, at most 4096 characters).
This supplies the editable/clipboard/fill input for a legacy stored reference,
while `label` supplies its resolved display. For example, a saved record key can
produce `{ color: null, label: 'Camera 16 · Studio', inputSource: '16' }`.
The host applies this projection only to a matching, current observation and never
rewrites the saved source or replaces a formula. It is transient feedback, excluded
from workspace and full-document transfer; those preserve original stored sources.
New numeric edits remain numeric. Missing or ambiguous references must remain
correctable, and may not silently select a different device. Publish local reference
presentation even when button colouring is disabled. Do not store live feedback in
settings or duplicate the host's spreadsheet editor in the package.

The kit's `examples/matrix-feedback` demonstrates separate editable values and
resolved labels without a device-specific host adapter. Test old stored references,
typed input, choice selection, copy/paste, fill, formulas, stale feedback and held
saves independently. A host lacking this feature needs one generic host update;
subsequent resolver, label and fill-rule changes ship in the module package.

`choiceProvider` uses contextual `discoverChoices`: the module receives the draft
values, query, pagination and cancellation signal. Device filtering belongs in
the module. `onChoose` sets declared companion fields in the same undoable edit.
Manual values use the field's validation; clearing retains an invalid draft for
correction. `mapping` exposes the same fields for mapping a discovered item to a
stable Matrix row and column.

`columnSettings` uses the public settings fields. Settings belong to the column,
are copied with it, and participate in undo, workspace transfer and full-workbook
clipboard transfer. `columnControls` names commands handled by
`call('matrix-control', { controlId, actionColumnId }, execution)` in the module.
The host checks the current workspace, worker generation and column ownership.

`legacy` is a compatibility mapping for an existing saved adapter and settings
key, not permission to add another host-specific implementation. Untouched
legacy sources and column IDs remain intact.

## Candidate additive contracts for Hubble 2.0.11

These features are under source qualification. Hubble 2.0.10 does not advertise
them; require the feature explicitly and verify the running host with `describe`.
Do not infer availability from the developer-kit version.

- `module-matrix-context-v1`: opt in to normalizing an old adapter with
  `legacy: { adapter, normalize: true }`. A physical connection can additionally
  declare its old `connectionType` to leave the host's legacy settings enum.
  Existing identities, sources and layout remain. `variants.when` may read
  `column.commandId` to supply defaults for old command-specific columns.
  Internal migration markers belong to Hubble; never author or alter them.
- `module-matrix-row-fields-v1`: use field `rules: [{ when, set }]` for row-dependent
  type, bounds, requiredness, choices and colour mode. Conditions reference other
  declared fields. Use `resolveModuleMatrixField` before module-side validation.
  `colorMode: 'pair'` uses the shared inactive/active colour control and stores
  `#112233 | #445566`. Preserve this order. Invalid drafts remain editable and
  must not dispatch commands or stop feedback for other rows.
- `module-matrix-migrations-v1`: a versioned `migrateSavedActions` callback receives
  native sources in `item.matrix: { id, fields: { fieldId: { mode, source } } }`.
  Increment `savedActionVersion` when migrating these sources. Preserve every
  item identity, ordering, source key and native/generic document kind. Add a
  field or explicitly transform its value; never silently drop an unknown saved
  field. The host does not expose cached evaluations or the connection-owner
  field. Selecting a package that cannot read an existing native document must
  fail without changing data. Removing a selection retains its saved document.

Generic action/JSON columns from older packages remain readable; declaring a
native Matrix must not silently reinterpret their JSON as cell values. Qualify
both forms, Advanced actions, formulas, selection rollback and database restart.
The kit's `examples/matrix-row-fields` demonstrates dependent limits, inactive/active
colours and a source migration that retains formulas and unknown fields. It uses
only local state and requires these candidate host features.

Additional shared controls in kit 1.5.0-dev.11 use explicit feature declarations:

- `module-matrix-collections-v1`: a text field may declare `orderedNumbers` with
  `min`, `max`, `minItems`, `maxItems` (up to 64) and `itemLabel`. The shared editor
  preserves order and rejects duplicates. Use `parseModuleOrderedNumbers` in the
  module. A colour field may declare `colorMode: 'palette'` and
  `colorPalette: { defaults, itemsField, itemLabel }` for up to 16 positions.
  Use `parseModuleColorPalette`/`formatModuleColorPalette`; dormant colours and
  the single-item colour remain saved when the active item count changes.
- `module-choice-bindings-v1`: contextual choices may return `values` for the
  primary field and companion fields listed in that field's `choiceFields`.
  Hubble validates the allowlist and applies the selection as one edit with one
  undo step. Put device/group interpretation in the provider; no host ID checks.
- `module-optional-numbers-v1`: optional numeric settings/table fields may use
  `default: null`. An empty value remains null, never zero. Required fields still
  reject empty drafts. In Matrix, requiredness may vary by row while inactive
  numeric fields retain their original sources.
- `module-contexts-v1`: `matrix.context: true` supplies the owning logical
  context ID to discovery, execution and feedback. See
  [contexts and local state](contexts-and-local-state.md).

The `examples/matrix-collections` project demonstrates ordered values, retained
palette colours and one-edit choices without any integration-specific host code.

`module-resource-limits-v1` supplies `context.services.request('resources', 1, ...)`
with `host.resources` and `host-service-registry-v1`. Acquire bounded claims with
`{ method: 'acquire', claims: [{ key, limit }], ttlMs }`; a granted response contains
`leaseId`. Release it in `finally` with `{ method: 'release', leaseId }`. Claims are
atomic and shared only within the workspace/module identity; leases also end with
their operation or generation. The module chooses device/origin keys and limits.
Hubble enforces generic capacity, ownership and cancellation. Acquiring requires
an explicit command, never startup or feedback observation.

For paired shortcut editing and workspace-scoped choice providers, see
[native controls](native-controls.md). They use generic declared capabilities;
workspace tools do not need a synthetic physical connection.

## Observations and execution

Implement `subscribeFeedback(subscriptions, { signal })`. Each Matrix subscription
has the declared feedback ID and fields:

```ts
const fields = {
  actionId: "row-action-id",
  actionColumnId: "stable-column-uuid",
  values: { "module.level": 75 },
  settings: { threshold: 50 },
};
```

`values` are validated/evaluated row values; `settings` are the effective column
settings. A disabled synthetic column subscription can exist before any row is
valid, so column controls can still work. Replace the previous subscription set,
publish its current state immediately, and update it when observations change.
The host reapplies subscriptions after worker replacement. This callback is
observational: it must not execute device commands or request mutating host services.
Button execution receives the same fields in the declared action. Keep commands
in `execute`/explicit controls and check cancellation.

Publish `{ id, fields, state, observedAt, appearance }` using the exact subscription
identity. `appearance` can contain `backgroundColor`, `glow: { color, cycleMs }`,
and `cells: { [fieldId]: { label?, color, inputSource? } }`. The optional
`inputSource` requires the feature described above. Colours are six-digit RGB hex;
glow cycles are 500–10,000 ms. Emit null appearance values for stale, disconnected
or disabled observations. The module decides protocol truth and appearance; the
host paints cells without replacing grid data and animates the fastest active
button glow. A presentation receipt must not repaint newer edited values.

Use `runtimeDirectory` for local runtime state that must survive module versions.
Document any data excluded from workspace export. Tally's follow-state file is
local runtime state; row colour/glow choices and column defaults are portable.
Cross-module actions use `context.modules` and explicit workspace permissions,
never a Tally-specific host service. Observation subscriptions do not grant action
permission. Ambiguous peer selection must fail clearly.

## Acceptance

Test the same generic renderer with Tally and an unrelated module. Include plain
and parameterized choices, discovery/manual/formula values, atomic companion
edits, copy versus series fill, clipboard, column copying, independent histories,
feedback during typing, held saves, second edits and rejection. Exercise
non-default transfer and real-worker restart. Verify stale feedback clearing and
that observing never executes a device action. Demonstrate a module-only update
with unchanged installed Hubble bytes; source tests alone do not prove that claim.

## Action authoring ownership

`manifest.actionUi: false` (SDK 1.6.0, API 1) opts the whole package out of new
Matrix and Advanced action authoring. Require `module-action-authoring-v1` and
Hubble 2.0.13 or newer. Pages, peer calls, feedback and existing saved actions
remain supported. The verified selection stores the policy and carries it through
workspace transfer. Omission means the existing authoring behavior, not a rewrite
of saved settings. Use this for tools such as TALLY Switch, whose follow control
already belongs in the TSL action and its own sidebar page.

A declared Matrix with a legacy adapter is offered once for that connection; the
host must not add a duplicate generic Module actions entry for the same surface.
Older packages without a Matrix may still expose distinct generic actions. Test
addition and Advanced pickers against the real catalog, not a hand-filtered fixture.
See `examples/sidebar-page` for a package with a callable peer action and no new
button authoring entry. Mock is not an authorable package and is never a release
dependency; test fixtures must remain outside `modules/` and shipped runtime exports.

## Quiet incomplete drafts

A required Matrix field may declare `showIncompleteWarning: false` when the host
advertises `module-matrix-quiet-incomplete-v1`. Require that feature. This hides the
editing hint for a blank literal while preserving required-field validation:
incomplete actions remain unpublished and cannot execute a previous action.
Invalid values and formulas still show their errors. Omission keeps existing hints.
