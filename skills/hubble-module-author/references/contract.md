# Contract and compatibility

Use the public SDK types (`@hubble/module-sdk` or `sdk/dist/index.d.ts` in the kit). The validator is
authoritative for the supported API schema. Unsupported lifecycle
features belong in a host implementation change, not guessed manifest fields.

- The manifest declares an independent exact module version and configuration
  version. Host package version and module version are separate.
- Standard field types are text, number, boolean, and choice. Dynamic-choice
  identifiers call the instance `choices(provider)` hook and return bounded ID/label pairs.
- In the updated Hubble2 API 1 kit, actions, feedback definitions, and static or
  dynamic choice entries may add `group: 'Transport'`. The host renders labeled
  sections in first-seen order, preserving order within each group. Omit `group`
  for an ungrouped entry. Labels are trimmed, nonempty plain text of at most 160
  characters; nested groups are unsupported. Group labels are presentation only:
  never encode them in IDs, saved field values, feedback keys, or execution logic.
  Regrouping needs no configuration migration. Require `module-presentation-v1`
  when depending on groups in the workbook and Advanced legacy action pickers
  (Hubble 2.0.1). Earlier API 1 hosts can accept the metadata without displaying it
  in those pickers. New actions on an existing connection use its “Module actions”
  entry and the generic action/feedback editor; do not extend host-owned legacy
  command enums. Static and live choice groups use the same presentation rules.
  Settings `choiceProvider` support, including workspace host modules, requires
  `module-settings-choices-v1`. Providers observe the current running instance;
  uncommitted form values are not passed to `choices(provider)`.
- Actions declare their stable ID, fields, timeout, and completion criterion:
  local change, transport submission, response, or observed state confirmation.
  `completionAlternatives` explicitly lists other possible evidence when one saved
  command can perform different operations. CCC, for example, returns local
  persistence, RCP response, or confirmed camera state. Never label an unconfirmed
  camera result as state-confirmed.
- `legacy: true` is reserved for compatibility actions whose original field
  validation is retained in a built-in adapter. Keep those IDs unchanged. New
  actions use descriptor fields and omit `legacy`; they appear in the generic
  Module action editor, including on existing built-in device connections.
- Hubble owns gestures: `press`, `rotate-left`, `rotate-right`, `long-press-1s`,
  `long-press-2s`, and `long-press-3s`. Do not add timing/gesture interpretation
  inside a device driver.
- Each connection instance owns its sockets, timers, subscriptions, and state.
  `start` must not send Take, Record, or another unsolicited control action.
  `dispose` must clean up partial starts and tolerate repeated calls.
- Pass cancellation to the actual transport and waits. Do not retry uncertain
  commands after timeout or reconnect. A timeout means lack of completion evidence,
  not proof that the device did nothing.
- Return exactly one success/failure. A socket write, HTTP response, RCP
  acknowledgment, and observed camera state are different evidence. Log only what
  the code observes, labeling attempts and waits as such. Never infer an unseen
  downstream hop. Keep secrets and raw sensitive payloads out of logs.
- Publish `unavailable` for unknown/stale feedback. Do not turn a disconnected
  device's unknown state into confirmed `inactive`.
- Module code describes fields and behavior; the host owns UI composition and
  persistence. Arbitrary executable UI panels, presets, and live variables are outside this
  initial contract.

For edits, capture representative saved settings and action fields before making
changes. Test non-default values, all supported actions, cancellation, failed
startup cleanup, instance independence, and reconnect without control replay.
The supplied simulator is a starting example, not a full conformance certification.

For router work, preserve manual/Automatic Take, dimensions and levels, grouped
selection, locks/salvos where supported, feedback from external changes, and
protocol-specific acknowledgment/readback. For CCC, separately record observed
RCP events and camera state. Do not invent a generic feature set to make drivers
look identical.

The host keys device instances by (workspaceId, connectionId), never connectionId
alone. Workspace capabilities use (workspaceId, capabilityId), where built-in IDs
are `ccc`, `system-actions`, and `mock`. They have portable version selections and
separate local source links; do not invent a physical connection to host them.
Each context supplies scope, settings, publishState, publishFeedback, and log.
Feedback with parameters includes `fields` matching its declared descriptor;
the action's feedback rule selects the same ID and values. Invalid or stale
feedback cannot assert a confirmed button state. Host reload clears feedback,
drains bounded work, disposes/exits the old worker, and starts a new generation.
The old package is restored if startup or configuration persistence fails.

A module crash/hang affects its connection. Memory, request count, IPC size,
feedback count and diagnostic queues are bounded. Modules still run with the
service user's operating-system permissions. Never describe them as sandboxed.

Built-in integrations can expose optional `call(method, value, execution)` services
and publish bounded JSON observations with `publishEvent(channel, value)`. Declare
`service.<method>` for every service. `requestHost(method, value, signal)` requires
`host.<method>` and an explicitly supported host capability. Shared router groups,
TSL persistence, CCC storage and signed native bridges stay in the host; their
module-owned protocol or command logic can reload independently. These privileges
are restricted to their built-in identities/scopes. Custom device modules own their
protocol clients and use the standard action/feedback API.

A host call may call back into the same worker; do not hold a global worker lock
across it. Cancellation does not free an outstanding operation until it settles.
Prepare/migration may not request host services. Mutating host services require an
active action or service call. Background probes are observational only. Native
bridge completion and permission errors remain authoritative.

Compatibility declarations describe the module runtime, not author tooling. New
module source declares `host.minimumVersion` and `host.requiredFeatures` as needed.
Keep permission capabilities separate from required features. API 1 does not impose
an automatic upper app-major limit. Test the oldest declared host and a current
host against representative saved settings/actions. Settings migrations are pure
data transformations; they do not migrate saved action fields or feedback rules.
Retain compatibility handlers where those contracts cannot be migrated.

## Declarative sidebar pages

SDK/tools/kit 1.1.0 supports optional `manifest.pages` on Hubble 2.0.2 with the
required feature `module-pages-v1`. See the [page contract](../../../docs/sidebar-pages.md)
and `examples/sidebar-page`. Pages contain settings forms, editable settings-backed
tables, read-only state tables and status fields. Table rows use stable IDs and
existing portable binding settings; publish transient status through `state.values`.
Use valid row defaults, preserve IDs, test immediate editing before saves resolve
and failure recovery, and cover non-default export/import values. Do not expose
module JavaScript in the renderer or bypass existing scope/command validation.
