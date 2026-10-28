> Test fixture only. This package is excluded from production module inventories, catalog visibility, and workspace activation.

# Mock

Official module `hubble-mock`, version **1.0.0**, using stable Hubble module API **1**.
Deterministic local action execution for development.

## Source ownership

- `src/index.ts` is the module entry; `src/module.ts` composes instance lifecycle and host capabilities.
- `src/manifest.ts` declares the supported actions, feedback, settings and required host features. Package identity and version live in `package.json`.
- `src/actions.ts` owns the action-ID/validator registry. `src/schema/` contains only this module's saved action and connection validators; no Hubble application schema is imported.
- Device clients own connection lifecycle and observed device state. Transport, command queues and confirmation helpers are separate where those responsibilities exist. Reusable protocols live in public `packages/`.
- `test/` covers action behavior and/or a local device simulator. The manifest/registry test prevents advertising actions without a local validator.

Existing saved IDs and completion evidence are preserved. Legacy descriptors keep Hubble's existing editors during migration; new actions can declare their own fields and handlers through the public SDK without editing host enums. Host persistence and native application access are requested through named capabilities.

## Develop

From this repository, run `pnpm --filter @hubble-module/mock build` and `pnpm --filter @hubble-module/mock test`.
`pnpm --filter @hubble-module/mock package` creates the versioned `.hubble-module` artifact.
Generated `dist/module.mjs` is a distribution bundle; edit the focused TypeScript source instead.
