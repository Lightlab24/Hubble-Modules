# Module independence API candidate

Prepared against the Hubble 2.0.2 source baseline. These additions retain API 1 and
negotiate individual host features. This checkout is an isolated candidate; it has
not been installed, deployed, or published. The matching public SDK and tooling
candidate is 1.2.0 in the sibling `Modules` checkout.

## Feature negotiation

| Feature                       | Contract                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `module-workspace-actions-v1` | Generic actions and feedback on the CCC and System Actions workspace scopes                     |
| `module-exchange-v1`          | Versioned shared data, subscriptions and approved public actions between modules                |
| `module-fields-v2`            | Conditional fields, multi-choice, objects, arrays, integer constraints, and validation messages |
| `module-choices-v2`           | Draft-sensitive search and pagination with revision and worker-generation checks                |
| `module-saved-actions-v1`     | Pure, transactional saved action/feedback migration and rollback                                |
| `host-service-registry-v1`    | Typed, versioned service descriptions and scope-specific grants                                 |

Declare the features a module requires in `host.requiredFeatures`. Unknown field
kinds and rich fields without their required feature are rejected during package
inspection. Older API 1 manifests and `choices(provider)` providers remain usable.
The existing `module-pages-v1` contract is unchanged. `host-services-v1` remains the
older alias contract; the typed registry deliberately requires a separate feature.

## Scope and saved data

Generic columns carry `moduleScope: { kind: 'connection' }` or
`{ kind: 'host', capabilityId: 'ccc' | 'system-actions' }`. Omitting the
scope preserves older connection-column semantics. Host columns require a null
`moduleConnectionId`; no synthetic connection ID is stored. Connection columns
retain their workspace module-connection reference, which resolves to the physical
connection at compilation. Published actions carry the resolved `moduleTarget`.

The picker, Advanced editor, and column menu select this scope. Manifest lookup,
choice discovery, execution, and feedback use the same scope and selected module.
The legacy Mock scope remains readable for migration and isolated tests; it is
excluded from production discovery and activation. An unavailable or mismatched selection fails closed. Workspace modules retain
module-owned automation and device handling; the host supplies generic contracts.

Saved formats advance to complete/portable workspace version 16, spreadsheet
transfer version 9, and SQLite schema 52. Older supported files remain readable.
The new optional database column defaults to null on upgrade. Workspace import,
replacement, duplication, clipboard transfer, and restart preserve scopes, saved
schema versions, and nested JSON values. Plain TSV cannot carry workspace module
selections: its versioned header rejects that lossy fallback and requests structured
Hubble clipboard data, as it already does for sheets and surface layouts. Update recovery journals remain local:
they describe transactions on this installation, not portable workspace content.

## Fields

All settings, generic action/feedback forms, and page table descriptors share the
same field schema. `multi-choice` stores ordered string IDs; `object` stores a JSON
object and declares child `fields`; `array` stores ordered values and declares an
`item` descriptor and `maxItems`. Array item identities used while editing remain
local to the renderer and are never serialized into the module's values. Array item
defaults must produce valid values so a new item can be saved immediately.

`visibleWhen` combines sibling comparisons with AND. Each comparison has `field`,
`equals`, and optional `negate`. Hidden values are retained. `validation.message`
replaces a field's validation error; text length bounds use `minLength`/`maxLength`.
Numbers retain fractional support and can opt into `integer: true`.

Descriptors are bounded to 128 top-level fields, 32 object children, 512 total
fields, four nested levels, and 128 array/multi-choice items. Settings retain their
existing JSON size limit. Nested secret fields are redacted from diagnostics and
cannot appear in page tables. The UI uses the shared validator and retains
unavailable selected IDs.

Array creation, deletion, ordering, and subsequent edits update immediately while
saves run in order. Failed creations discard edits to the missing item. A failed
delete or move restores that operation while preserving edits to surviving items
and unrelated fields. Receipts carry no serialized editing identities.

## Contextual choices

An optional `discoverChoices(query, { signal })` hook receives version 2 queries:
`provider`, current unsaved `draft` values, `search`, nullable `cursor`, `limit`,
and `requestRevision`. Subsequent pages also carry `catalogRevision` and the
worker `generation`. Return `{ revision, choices, nextCursor }` with at most 128
unique IDs. Keep a revision stable only while its catalog and cursor interpretation
remain valid. Reject an obsolete cursor and honor cancellation.

The host attaches the exact package digest, generation and request revision.
Consumers discard replies for an obsolete workspace, package, worker, draft or
request. Search results and pages never save settings or reset edits. The editor
retains up to 4,096 choices before requiring a narrower search. API 1 providers
receive a bounded, filtered pagination adapter without changing their signature.

Discovery must be read-only. The host rejects command-only service requests from
discovery; it does not invoke a module action to populate a dropdown. Workers are
not an OS sandbox: authors remain responsible for keeping their own transports and
module initialization free of discovery-triggered control writes.

## Saved actions and feedback

`savedActionVersion` defaults to 1 for older manifests and bindings. Increment it
when a module changes the interpretation of generic saved action/feedback data,
and implement `migrateSavedActions(actions, fromVersion, toVersion)`.

The hook runs in a separate worker without creating a module instance or providing
host services. Each record contains a stable `key` and three source expressions:
`actionId`, `actionFields`, and `feedback`, each with `mode` and `source`. It receives
only generic bindings owned by that scope, including regular actions, Advanced
actions and Advanced feedback. It must return every key in the same order. Treat
formula sources deliberately; they are not evaluated by the module migration.
A migration is bounded to 8,192 owned records. Saved source expressions retain
the existing 4,096 Unicode-character limit.

The host validates the output, checks literal definitions against the target
manifest, compiles changed expressions, and commits the selection, settings and
saved expressions as one revision-checked workbook transaction. Failed persistence
leaves all saved data unchanged and restores the previous running package. Undo
restores the same transaction. Automatic updates journal the migration before the
commit and recover an interrupted receipt without applying it twice. Rollback
refuses to overwrite newer edits to the migrated bindings.

This hook does not rewrite legacy compatibility adapters. Keep their handlers
compatible; automatic updates retain the existing legacy-contract checks.

## Host services

`describe` includes service definitions (versions and request/response schemas) and
per-scope `declared`, `granted`, and `available` flags. A module can use
`context.services.describe(signal)` and
`context.services.request(service, 1, input, signal)` after preparation. API 1
`requestHost` aliases remain supported.

The registry describes `ccc-store`, `keyboard`, `tsl`, `router-groups`, and
`livegrade`. It preserves the existing module identity, active workspace, enabled
connection, scope, command-origin, and cancellation checks. A capability declaration
alone grants no authority. Only CCC `read` and LiveGrade `probe` are available
outside an active execute/call origin; other service operations retain their command
requirements. Cancellation prevents new dispatch and rejects late receipts; it
cannot undo an operation already delivered to a provider.

The registry exposes no general IPC or database mutation interface. New privileged
services and new workspace entity types still require an explicit host contract.

## Authoring candidate and handoff

The public SDK/tooling 1.2.0 candidate includes an inert `examples/independent-api`
project and pure migration conformance helper. The offline developer kit builds,
tests, validates and packs projects without a Hubble checkout. Its service client
can send the versioned discovery operation using `service request JSON_FILE` and
inspect grants using `service describe`.

The candidate archive and prospective lockfile are generated in the isolated
Modules checkout's `artifacts` directory. They are not published releases. The
production Hubble developer-kit pin remains unchanged. At an authorized release, publish the verified candidate bytes, then
apply their generated pin and qualify the final app. No desktop package, installation,
active RCP test, or production device connection is part of this isolated work.

## Routed module exchange and lifecycle

See [module exchange](module-exchange.md) for the candidate exchange contract,
import approvals, removal/re-addition, and the external-only execution boundary.
