# Publishing approved modules

Build first-party candidates in this public repository with `pnpm build`, then
`node scripts/modules.mjs package <name>`. Each source package owns its version.
The credential-free **Qualify module candidate** workflow runs the same command.
Community projects use the portable developer kit. Review tests and exact archive
bytes; these steps do not build Electron or publish anything.

1. Assign a new module version and qualify its behavior. Preserve existing saved
   action/field IDs. Never replace a published version's bytes.
2. Create a draft release in this repository named
   `module-<module-id>-v<version>` and upload exactly
   `<module-id>-<version>.hubble-module`. A maintainer can use the authenticated
   GitHub CLI; no private-repository token is shipped to users or this workflow.
   Run `node scripts/stage-candidate.mjs ARCHIVE NOTES_FILE beta catalog-candidate.json`
   to inspect the archive, stage the draft, and prepare the next catalog input.
   Use `stable` only after the module meets the stable qualification requirements.
3. Prepare and review `catalog-input.json` on `main`. Retain historical entries,
   use formatVersion 2, increase `sequence`, set fresh ISO `issuedAt`/`expiresAt`, and add the exact
   inspected manifest, digest, archive length, immutable download URL, notes,
   publication time, and `stable` or `beta` channel. Withdraw rather than delete
   old entries. A metadata-only renewal uses the same process without new assets.
4. Run **Publish reviewed module catalog** from `main` with that input path.
   The `module-publication` environment requires maintainer approval. It holds
   the dedicated Ed25519 signing key; the job uses GitHub's short-lived token
   scoped to this repository. It has no access to the private application source.
5. The workflow inspects new archives as data without executing their code,
   confirms immutable historical entries, publishes fully uploaded drafts, and
   advances the signed catalog using the previous content SHA. If publication
   succeeds but catalog advancement fails, inspect the state and rerun the same
   input; do not rebuild or replace existing assets.
6. Check the feed in an isolated Hubble test profile. Discovery and download must not reload a module.
   Activate only the intended connection/version using Apply and reload.

The catalog URL is
`https://raw.githubusercontent.com/Lightlab24/Hubble-Modules/module-catalog/catalog-v2.json`.
Publication also updates `catalog.json` with only manifests older readers can
decode; it never rewrites an immutable manifest to fit an older schema. A repeated
identical v2 input can finish a failed legacy-subset update without replacing bytes.
Clients trust the public key embedded in their host build, not a key downloaded
alongside an arbitrary catalog. Key rotation requires a planned host update.
Keep the catalog's expiry current even when no module versions change.

GitHub immutable releases are enabled for this repository. Upload every intended
asset while the release is still a draft. Once published, use a new version/tag
for corrected bytes; an existing module release is not an editable update slot.

The module catalog and the application's curated bundled-module lock are
independent. Inclusion in a downloadable application release remains a separate
maintainer decision. Do not publish an application release from this repository.

## Curated app assets and author kit

`pnpm kit` builds and exercises the standalone author kit outside this checkout.
Release its exact `hubble-module-developer-kit-<version>.tar.gz` under
`developer-kit-v<version>`; changing kit bytes requires a new kit version.
`pnpm package:modules` writes a reviewed URL/size/digest lock for all 14 archives.
After qualification, `node scripts/export-hubble-lock.mjs HUBBLE_CHECKOUT` copies
those exact local artifacts into the app's cache and writes curated locks plus
exact internal-2.0.0-to-official-1.0.0 identity transitions. It does not publish.
Verify release downloads match these pins before shipping the app.

The app staging command uses only those locks and cached or downloaded artifacts;
it never follows latest or compiles module source. Pins and developer links are
not generic version migrations. The one-time version reset uses only the explicit
known previous identity/digest allowlist.

The host's temporary compatibility bridge is built by `pnpm build:host-bridge`.
It contains canonical public clients for legacy app call sites and is not imported
by independent module packages. Its immutable archive is published under
`runtime-v<version>`, with a size/digest pin and content-addressed local app cache.

For a kit or bridge, run `node scripts/distribution-release.mjs stage PIN_JSON
releases/REVIEWED_PIN.json` after its source commit is pushed. This verifies local
bytes, stages a draft asset, downloads it for exact verification, and writes the
reviewable pin. Commit that pin, then run **Publish reviewed module catalog** with mode `distribution`
from `main`. This protected job downloads/verifies the asset before publishing; it
does not build or execute artifact code. Never reuse a version for different bytes.

Catalog GETs and compare-and-swap PUTs explicitly target `module-catalog` (override
with `MODULE_CATALOG_BRANCH` only for another non-main catalog branch). Create that
branch from the reviewed source commit before first publication so its existing
signed legacy feed provides the baseline. Neither publication mode writes or merges main.
The prior main-branch legacy feed remains untouched; the dedicated catalog branch
contains a renewed legacy subset alongside v2. Release tags target the exact
reviewed source commit.

`pnpm package:authors` packs public SDK/tools and all shared/client/protocol tarballs for independent GitHub
releases (`sdk-v<version>` , `tools-v<version>` and `contracts-v<version>`), using the same reviewed-pin
distribution workflow. The external starter references those immutable URLs; no
private npm registry or application source dependency is needed.

For the initial coordinated release, commit a pin-list JSON such as
`{"formatVersion":1,"pins":["releases/module-sdk.json","releases/module-tools.json"]}`
including **all** SDK, tools, shared/client/protocol, kit and host-bridge pins. Run
`publish.yml` once in `initial-release` mode with that `pins` path and the reviewed
`catalog` input. The single protected job verifies every standalone archive before
publishing any, publishes that batch idempotently, then verifies/publishes modules
and signs the catalog. It needs one environment review and does not weaken branch
or reviewer protection. Shared package source uses explicit `workspace:1.0.0`
requirements; packed manifests replace these with exact immutable GitHub URLs.
