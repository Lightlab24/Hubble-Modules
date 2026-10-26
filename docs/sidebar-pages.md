# Module sidebar pages

Hubble 2.0.2 supports module-owned sidebar screens through API 1's optional
`manifest.pages` declaration. Use SDK/tools/developer kit 1.1.0 and declare:

```ts
host: { minimumVersion: '2.0.2', requiredFeatures: ['module-pages-v1'] }
```

A selected connection gets a sidebar entry for each page, labelled with the
connection name. Workspace host bindings also support pages. Selecting a new
module version refreshes the pages without restarting Hubble or reloading HubDash.
A page that disappears shows an unavailable notice; it cannot retain a stale editor.

## Declare a page

```ts
settings: [
  { id: 'title', label: 'Studio name', type: 'text', required: true, default: 'Studio' },
],
pages: [{
  id: 'setup', label: 'Camera setup',
  sections: [
    { type: 'settings', id: 'settings', label: 'Settings', fields: ['title'] },
    { type: 'table', id: 'cameras', label: 'Cameras', source: 'settings', maxRows: 128,
      columns: [
        { id: 'name', label: 'Name', type: 'text', required: true, default: 'Camera' },
        { id: 'enabled', label: 'Enabled', type: 'boolean', required: true, default: false },
        { id: 'gain', label: 'Gain', type: 'number', required: true, default: 0, min: -12, max: 24 },
        { id: 'mode', label: 'Mode', type: 'choice', required: true, default: 'auto',
          choices: [{ id: 'auto', label: 'Automatic' }, { id: 'manual', label: 'Manual' }] },
      ],
    },
    { type: 'status', id: 'status', label: 'Status',
      fields: [{ id: 'connected', label: 'Connected cameras' }] },
  ],
}],
```

A settings section references existing `manifest.settings` IDs. The standard field
editors render text, secret text, numbers, booleans and static/live choices.
A table declares its own columns and storage key. Its `id` must not collide with a
scalar setting or another editable table. Table columns cannot contain secrets.
All editable table defaults must be valid so Add row creates a complete editable
item immediately. `choiceProvider` uses the existing read-only choice contract.

There can be 16 pages, 16 sections per page, 32 columns per table and at most 512
rows per table. Each table declares `maxRows`. The table editor also bounds saved
JSON and clipboard input to 262,144 UTF-16 code units. The complete binding's
settings share that same JSON-size limit, including scalar settings and all tables.
Labels and descriptions are text. HTML,
JavaScript, custom IPC handlers and arbitrary database access are not page features.

## Storage and worker state

Editable rows are stored in the selected binding's settings under the table ID:

```json
{
  "title": "Studio A",
  "cameras": [
    {
      "id": "camera-b",
      "values": { "name": "B", "enabled": true, "gain": 1.5, "mode": "manual" }
    },
    {
      "id": "camera-a",
      "values": { "name": "A", "enabled": false, "gain": 0, "mode": "auto" }
    }
  ]
}
```

Read this through `context.settings.cameras`. `ModuleTableRowsSchema` checks row
structure and IDs; `validateModuleSettings(manifest, settings)` also checks typed
column values, required fields, bounds, row limits and duplicate identities.
An absent table key in an older workspace means an empty table. Row IDs are stable
across edits and reordering; duplicates receive new IDs. Do not treat row positions
as device identities. Row values use choice IDs, while the UI displays their labels.

Settings and table saves use the existing module settings lifecycle: the host
persists the binding and reconciles that module instance. A worker must obtain
current settings from its new context. Opening or viewing a page does not call
an action. Whether a module applies settings to hardware is its own documented
lifecycle behavior; the example module controls no hardware.

For a read-only table use `source: 'state'`. Publish an array of the same row shape
at `publishState({ ..., values: { [tableId]: rows } })`. Status sections read each
field ID from `state.values`. These observations are transient and are not workspace
configuration. They update through the existing manager state refresh.

## Editing and transfer

The host provides spreadsheet typing, typed checkbox/choice cells, range copy and
paste, row inspectors, add, duplicate, delete and reorder. Row and cell edits appear
before persistence completes. Ordered background saves reconcile by row identity;
failed row creation removes edits that depend on that row and preserves unrelated
settings/row edits. Save failures use the existing fading toast. Navigation does not
cancel queued saves. Grid undo/redo is local to the current mounted table session.

Table settings, IDs, values and row order travel in the existing generic module
binding. They survive full workspace export/import, replacement, restart and
applicable full Button Matrix clipboard transfers. There is no new workspace
schema. Selecting a sidebar tab is transient. Sidebar ordering follows the existing
per-device navigation preference and is intentionally not exported with workspaces.

Keep page, table and column IDs stable. A column rename is a label change; changing
its meaning, type or saved ID requires a `configVersion` bump and pure
`migrateConfig`. Keep non-default migration/rollback fixtures. Retain compatibility
for saved action and feedback IDs, whose migration is a separate contract.

## Try the local example

`examples/sidebar-page` in Hubble-Modules contains a complete simulator with a
settings form, camera table and live counts. In the standalone kit use:

```sh
node module-tool.mjs build examples/sidebar-page
node module-tool.mjs test examples/sidebar-page
node module-tool.mjs pack examples/sidebar-page /tmp/example-sidebar-1.0.1.hubble-module
```

Import and select that archive on an External Module connection in an isolated
workspace. Change its page label or add a section, bump its independent module
version, rebuild and select the new archive. The existing sidebar and page update
without a host binary update. Do not change an archive under an existing identity.

Existing specialized host screens, including CCC, remain available. This API
provides common settings/table/status screens; additional widget types or privileged
host services need a new negotiated capability before modules can use them.
