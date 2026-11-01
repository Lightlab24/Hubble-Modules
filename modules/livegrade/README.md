# LiveGrade

Official module `hubble-livegrade`, version **1.1.0**, using stable Hubble module API **1**.
LiveGrade slot selection through the generic public `native-menus@1` service.
Candidate minimum host: Hubble 2.0.11; API major remains 1.

## Source ownership

- `src/index.ts` is the module entry; `src/module.ts` composes instance lifecycle and host capabilities.
- `src/manifest.ts` declares the supported actions, feedback, settings and required host features. Package identity and version live in `package.json`.
- `src/actions.ts` owns the action-ID/validator registry. `src/schema/` contains only this module's saved action and connection validators; no Hubble application schema is imported.
- Device clients own connection lifecycle and observed device state. Transport, command queues and confirmation helpers are separate where those responsibilities exist. Reusable protocols live in public `packages/`.
- `test/` covers action behavior and/or a local device simulator. The manifest/registry test prevents advertising actions without a local validator.

Saved IDs, formula sources, Studio letter positions and 7/Frontier query rules are
preserved. The package owns settings, Matrix/Advanced fields, dynamic slot choices,
edition identities, menu roots, validation, catalog interpretation and labels.
Hubble supplies shared controls, ordered persistence and generic native access.
Completion is correctly reported as native **response** evidence; an accepted menu
command does not prove observed selected state.

`src/native-menu-client.ts` resolves all four editions through package profiles,
reads bounded paginated catalogs, retains raw paths and requires the same process
and slot identity before invocation. Commands are never automatically retried.
`src/matrix.ts` owns presentation and legacy field normalization. An older package
can still use Hubble's legacy compatibility path; the new package never requests
`host.livegrade` or the specialized LiveGrade service.

Offline fixtures inject native responses and do not control macOS applications.
Actual Accessibility, edition menus and background focus still need installed-app
acceptance before any live-verification claim.

## Develop

From this repository, run `pnpm --filter @hubble-module/livegrade build` and `pnpm --filter @hubble-module/livegrade test`.
`pnpm --filter @hubble-module/livegrade package` creates the versioned `.hubble-module` artifact.
Generated `dist/module.mjs` is a distribution bundle; edit the focused TypeScript source instead.
