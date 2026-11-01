# Modules communicating through Hubble

`module-exchange-v1`, API 1. Hubble 2.0.4 adds per-module data access approvals.

## Ownership and approval

Modules publish versioned data, answer queries and observe subscribed events through
`context.modules`. Hubble routes requests, checks workspace identity and approvals,
and manages cancellation. Data interpretation and automatic behavior remain in modules.

Each consuming module has one **Allow access to other modules’ data** checkbox. It
covers public data from every current and future module in that workspace. The warning
explains that shared data can include camera status, routing and other module state.
There is no per-target checklist or binding-name editor. Approval is tied to a module
instance and its exact module ID, survives version updates, and defaults to denied.

Data approval does not authorize actions. The explicit action API retains its separate
scoped authorization check, and requires data access too. Setting the data checkbox
clears that consumer's superseded action approvals. Old approvals cannot independently
authorize execution. Import always revokes saved action approvals.

The single workspace import dialog shows one checkbox per module, with select-all and
clear-all controls. Saved data choices are prechecked for review. Cancelling changes
nothing; omitted decisions deny access. Approvals apply only after import completes.
Export and import preserve data choices, remap connection identities and deny missing
consumers. Spreadsheet-only import and clipboard transfer retain the destination's
workspace permissions because a spreadsheet does not own module access.

Turning data access off immediately cancels pending queries and deliveries. Subscriptions
become unavailable without exposing cached data, and late results are rejected. Changing
a module's permission refreshes that module's worker so startup subscriptions can adopt
the decision. The checkbox never enables a connection or issues a device command.

## Author contract

Declare `exchange.data` entries with `id`, `label`, integer `version`, and `query`.
Require `module-exchange-v1` in the manifest. Use:

- `discover()` and `bindings()` to resolve workspace peers and saved named bindings;
- `publish(id, version, value)` for a current data snapshot;
- `query(target, {id, version, input}, signal)` and `queryData` for read-only queries;
- `subscribe(filter, listener, signal)` for data or explicitly selected public action
  IDs and phases; dispose its returned asynchronous unsubscribe function;
- `execute(target, actionId, fields, signal)` for an approved public action;
- `reportAction(activity)` for module-observed action activity, with a stable
  execution ID and phase. Reports already observed by Hubble are deduplicated.

Data subscribers receive current availability and the current snapshot, then changes.
Action subscriptions receive future matching activity only. Hubble supplies trusted
caller identity, worker generation and causal context. Modules cannot supply them
in the request payload. Data versions that are no longer supported become unavailable.

Read-only queries and choice callbacks cannot publish, report, subscribe, or execute
commands through the exchange API, including from deferred callbacks. Startup cannot
execute another module's actions. Worker isolation is a lifecycle boundary; it is
not an operating-system sandbox for arbitrary module code.

## Lifecycle and bounds

Removal, disabling, workspace changes, revocation and worker replacement cancel
affected pending requests. Generation checks reject stale callbacks. Provider
replacement preserves the consumer worker and subscription while delivering fresh
availability and data. Commands and historical events are never retried or replayed.

Repeated action paths and causal chains beyond 16 hops are rejected. Limits include
128 requests per caller per second, 128 pending requests, 128 subscriptions per
consumer/1,024 total, 256 KiB per snapshot, and separate 16 MiB aggregate snapshot
and delivery budgets. Each subscription queues at most 64 notifications; adjacent
data updates coalesce, and overflow reports unavailability. Diagnostics identify
denials and cycle/overflow decisions.

The public developer kit includes inert `exchange-provider` and `exchange-consumer`
examples. They operate only on an in-memory counter and illustrate queries,
subscriptions, permission denial, module-owned automation and cleanup.

## External module lifecycle

HTTP Requests, CCC and System Actions support workspace removal and re-addition.
Removed host selections are persisted as `null`, so bundled defaults cannot
resurrect them. Existing saved actions remain readable and fail with an unavailable
module result until an appropriate module is restored. Module removal stops its
worker before the save; failed persistence restores the previous worker. The UI
updates immediately and preserves later unrelated edits while saves are pending.

Hubble has no default CCC, HTTP, System Actions, Mock, or device action executor.
The production service import-graph test verifies their exclusion. Mock is
excluded from the live registry, catalog, bundle staging and activation. Its source
and legacy schemas remain available to explicit isolated test fixtures. Native
keyboard/Automation Bridge services remain generic host capabilities used by the
external System Actions module.
