# Hubble module developer kit

This kit builds independent module releases. SDK/tool versions, module versions,
module API versions and settings schema versions are separate. Node 22 or newer is
required. No Hubble application checkout or application rebuild is needed.

Candidate kit **1.7.0-dev.4** contains SDK **1.7.0**, module tools **1.5.0**,
and module API **1**. It adds `module-matrix-fill-rules-v1` (Hubble 2.0.15):
modules declare copy/increment per field and may override that policy by action
through `rules[].set.fill`. See the Matrix skill reference and the exported
`matrix-feedback` example. Each editable Matrix/page-table field owns its policy;
observed and computed tables remain read-only.

It also adds `module-table-live-v1`: document tables may show module-owned live
values in declared editable columns while ordered saves are pending. The shared
host protects active edits and keeps transient observations out of persisted
documents. Require the feature explicitly; this needs compatible host support,
not just an updated SDK. See the native-workbooks skill reference.

The kit also retains `module-matrix-input-source-v1` (Hubble 2.0.12):
modules can supply an editable input separately from the resolved display of a
legacy reference. This keeps clipboard and fill on user-facing values. See the
Matrix skill reference and `examples/matrix-feedback`. Numeric reference
resolution, friendly labels and series/copy declarations belong in packages;
the shared host supplies editing, rendering, fill dispatch and persistence.

Candidate kit 1.5.0-dev.5 adds package-owned browser frontends through the public
`@hubble/module-sdk/frontend` entry and the `examples/custom-canvas` project.
See [custom pages](../skills/hubble-module-author/references/custom-pages.md) for
the compatibility declaration, build options, bridge and current limits.

Candidate kit 1.5.0-dev.7 also includes portable documents and shared datasets:
see [documents](../skills/hubble-module-author/references/documents.md) and
[datasets](../skills/hubble-module-author/references/datasets.md). The canvas example
links a shared cell by stable identity and uses the same saved data from its Matrix
action. These contracts require the declared candidate host features; the kit does
not install them in an older Hubble app.

Candidate kit 1.5.0-dev.8 adds [package-owned helpers](../skills/hubble-module-author/references/helpers.md):
declared Node/native processes, verified assets and lifecycle managed by the host.
The canvas example's preview renderer is now a separately bundled Node helper.

Candidate kit 1.5.0-dev.9 adds [workspace instances](../skills/hubble-module-author/references/workspace-instances.md).
The canvas example now declares workspace scope. Compatible packages can register
one instance per module ID per workspace without a device connection or host enum.

Candidate kit 1.5.0-dev.11 adds scoped logical contexts, disabled-connection local
state, shared ordered-number/palette editors, atomic multi-field choices and
optional nullable numeric fields. See `examples/matrix-collections` and the
contexts/local-state and Matrix skill references. These remain additive API 1
contracts with explicit host feature requirements.

Candidate kit 1.5.0-dev.12 completes the disabled-state declaration with
`matrix.availableWhenDisabled`. It keeps declared local actions available in
Matrix and Advanced actions while leaving device commands disabled. The local
cue example tests both lifecycle modes.

Candidate kit 1.5.0-dev.14 adds generic native-control grants, workspace Matrix
discovery and paired shortcut editors. See `examples/native-controls` and
[native controls](../skills/hubble-module-author/references/native-controls.md).
It also preserves optional workspace connection contexts and validates native
feedback in the example. The unpublished dev.13 artifact is superseded because
its example used an invalid timestamp for inactive feedback.
Its test supplies an inert provider; it does not automate the operator's Mac.
Application profiles and native focus guarantees remain a separate capability.

Candidate kit 1.5.0-dev.10 added package-owned document preparation and pure version
migrations, atomic with package selection, plus declarative duplicate defaults.
See [documents](../skills/hubble-module-author/references/documents.md) and
`examples/prepared-document`. Hubble supplies persistence and shared controls;
the package supplies validation, normalization, migrations and workflow decisions.

```sh
cd -P /path/to/kit
node ./module-tool.mjs create ./example example-device
node ./module-tool.mjs build ./example
node ./module-tool.mjs test ./example
node ./module-tool.mjs validate ./example
node ./module-tool.mjs pack ./example example-device-1.0.0.hubble-module
node ./module-tool.mjs inspect example-device-1.0.0.hubble-module
```

The portable CLI includes its compiler runtime. For editor types and extra project
dependencies, install the project's declared packages. Keep editable code in `src/`;
generated `dist/` contains the runtime manifest and bundled entry. Build executes
author source; validate, pack and inspect do not. Legacy root-manifest JavaScript
projects remain supported without a compile step. A large generated bundle is normal;
do not edit it or duplicate source declarations in it.

`package.json` owns ID, display name and independent version. `src/manifest.ts`
composes settings, actions and feedback descriptors. `src/index.ts` assembles the
lifecycle implemented in `instance.ts`; add focused protocol, transport and state
files as needed. Use `createActionRegistry` to reject missing/extra handlers and
incorrect completion evidence. Shared protocol libraries may depend on public
contracts, never private app files or another module's internals.

Declare the minimum full Hubble version and required host features. API 1 remains
supported by newer compatible hosts; new modules need not work on older apps.
Unknown future module APIs remain visible but unavailable. Stable saved action,
feedback, field and choice IDs are contracts: retain handlers and meaning across
releases. `migrateConfig` changes settings only, with no hardware or host-service
calls. It does not migrate workbook action fields or feedback rules.

Test with the public harness and module-owned simulators: independent instances,
startup/reconnect without control writes, cancellation reaching transport, no
uncertain-command replay, partial-start and repeated-dispose cleanup, unavailable
stale feedback, accurate completion evidence and secret-free diagnostics/errors.
Keep non-default previous-version fixtures and test settings migration/rollback.
Package only declared runtime files, preserving dependency license notices.

Run the published 1.0.0 kit from its canonical directory as shown above. Its direct
entry guard can silently skip an absolute path containing a macOS directory alias
such as `/var` instead of `/private/var`.
Version 1.2.0 resolves the CLI entry through symlinks, and kit qualification checks
each command's result so a skipped invocation cannot count as a passing test.

Use `node ./service-client.mjs --url http://127.0.0.1:42838 describe` for Hubble's
default browser/service API, or use the saved browser port. An isolated Hubble2
development service normally uses port 42841. The client requires `--url`; it never selects either product implicitly. Import/download never selects a version. Link a built source
project and explicitly reload to test it; automatic updates, when enabled, apply
only at the next service startup. Device commands require an authorized test target.
Workers provide failure isolation, not an operating-system sandbox.

The author skill in `skills/hubble-module-author/` documents the complete workflow.
Publishing is a separate reviewed release operation, never a side effect of build.

Read [Hubble and module ownership](skills/hubble-module-author/references/ownership.md)
before extracting an integration or claiming independent updates. Shared controls
and platform services belong to Hubble; integration declarations and behavior belong
to the package. An external worker alone does not establish UI independence.

For the required custom frontend, shared-data/document, Matrix-composition and
helper model, read [the extension model](skills/hubble-module-author/references/extension-model.md).
It distinguishes required platform work from supported APIs. Current declared
settings/table/status/controls pages remain supported. The 1.5.0-dev.8 candidate
adds [custom frontend sections](skills/hubble-module-author/references/custom-pages.md)
and [portable documents](skills/hubble-module-author/references/documents.md) for
the intended Hubble 2.0.11 host, together with shared dataset links and helper
lifecycle. Check capabilities and platform limits; installed 2.0.10 cannot run
these new contracts. Large portable binary-asset storage remains separate work.

`examples/matrix-feedback` targets the existing Hubble 2.0.10 Matrix API.
`examples/matrix-row-fields` demonstrates the candidate 2.0.11 row-dependent
editors and native source migrations. The latter requires features unavailable
in 2.0.10; building it is not permission to activate it on an incompatible host.

For an installed toolchain, run `pnpm install` in the generated project: its SDK
and tools dependencies use immutable GitHub release tarball URLs. The standalone
kit commands above require no npm installation. Optional typed shared host-service
data contracts are published as `@hubble/module-contracts` at the
`contracts-v1.0.0/hubble-module-contracts-1.0.0.tgz` GitHub release asset. Import only
the public contract your module uses and declare its corresponding host feature
and permission; do not depend on the host compatibility aggregate package.

To edit one official module outside the monorepo, run
`node scripts/export-module-project.mjs <module-directory> <new-project-directory>`
from a qualified public checkout. It exports source/tests with exact public GitHub
dependency URLs and its own compiler/test configuration. Run `pnpm install`, then
`pnpm build`, `pnpm test`, and `pnpm typecheck` in that project. Choose your own
module ID/version before publishing a separate fork. Shared package tarballs expose
compiled JavaScript and declarations; no workspace paths remain in their dependencies.

## Sidebar screens

SDK/tools/kit 1.1.0 adds [declarative sidebar pages](sidebar-pages.md) for Hubble
2.0.2 (`module-pages-v1`). The kit includes `examples/sidebar-page`, a local simulator
with settings, a typed spreadsheet and live status. Module-only changes can add pages,
sections and columns on a compatible host.

## Matrix API in kit 1.4.0

API 1 adds package-owned Matrix descriptors and feedback subscriptions on Hubble 2.0.10. Read [the Matrix contract](skills/hubble-module-author/references/matrix.md) and use `examples/matrix-feedback`. Device-specific editors, controls and appearance rules belong in the external package. A module-only update must be demonstrated against unchanged host bytes.

Candidate kit **1.5.0-dev.17** adds `native-menus@1`, exact executable and root
selection, process preconditions, focus evidence, and the independent
`examples/native-menu` package. LiveGrade 1.1.0 declares its profiles, slot rules,
settings and Matrix fields through these public APIs. API major remains **1**;
the feature requires candidate Hubble **2.0.11**. This candidate does not replace
installed Hubble 2.0.10 or publish/overwrite the pinned developer kit.

### Page and peer actions

SDK 1.6.0 adds `actionUi: false` for modules whose actions belong to peer calls or
existing saved documents rather than new Matrix/Advanced action pickers. This
requires Hubble 2.0.13 and `module-action-authoring-v1`; API 1 remains unchanged.
The sidebar-page example demonstrates this policy. Module Tools 1.5.0 rejects
Mock package creation and distribution. Mock is only a test fixture, not a module
users can install or choose.

## SDK 1.2.0 candidate

The isolated 1.2.0 kit includes [the independence API](independence-api.md) and an
`examples/independent-api` project. It demonstrates richer forms, contextual choices,
service descriptions and pure action/feedback migration using local simulator state.
The SDK and tooling versions remain independent of a module's version. These candidate
artifacts have not been published; use the locally generated kit for offline checks.

## Module exchange examples

The kit includes `examples/exchange-provider` and `examples/exchange-consumer`.
They use an inert counter to demonstrate [routed data and approved actions](module-exchange.md),
including module-owned automatic reactions and subscription cleanup. These examples
are not production catalog modules.
