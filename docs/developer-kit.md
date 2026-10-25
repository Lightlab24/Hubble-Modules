# Hubble module developer kit

This kit builds independent module releases. SDK/tool versions, module versions,
module API versions and settings schema versions are separate. Node 22 or newer is
required. No Hubble application checkout or application rebuild is needed.

```sh
node /path/to/kit/module-tool.mjs create ./example example-device
node /path/to/kit/module-tool.mjs build ./example
node /path/to/kit/module-tool.mjs test ./example
node /path/to/kit/module-tool.mjs validate ./example
node /path/to/kit/module-tool.mjs pack ./example example-device-1.0.0.hubble-module
node /path/to/kit/module-tool.mjs inspect example-device-1.0.0.hubble-module
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

Use `service-client.mjs --url http://127.0.0.1:42841 describe` for an isolated
Hubble2 service. Import/download never selects a version. Link a built source
project and explicitly reload to test it; automatic updates, when enabled, apply
only at the next service startup. Device commands require an authorized test target.
Workers provide failure isolation, not an operating-system sandbox.

The author skill in `skills/hubble-module-author/` documents the complete workflow.
Publishing is a separate reviewed release operation, never a side effect of build.

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
