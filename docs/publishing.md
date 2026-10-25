# Publishing approved modules

The private Hubble repository builds first-party candidates with
`node scripts/modules/prepare-module-candidate.mjs modules/<name>`.
Community projects use the portable developer kit. Neither operation rebuilds
Electron or publishes a package. Review the test result and exact archive digest.

1. Assign a new module version and qualify its behavior. Preserve existing saved
   action/field IDs. Never replace a published version's bytes.
2. Create a draft release in this repository named
   `module-<module-id>-v<version>` and upload exactly
   `<module-id>-<version>.hubble-module`. A maintainer can use the authenticated
   GitHub CLI; no private-repository token is shipped to users or this workflow.
   Run `node scripts/stage-candidate.mjs ARCHIVE NOTES_FILE beta catalog-candidate.json`
   to inspect the archive, stage the draft, and prepare the next catalog input.
   Use `stable` only after the module meets the stable qualification requirements.
3. Prepare and review `catalog-input.json` on main. Retain historical entries,
   increase `sequence`, set fresh ISO `issuedAt`/`expiresAt`, and add the exact
   inspected manifest, digest, archive length, immutable download URL, notes,
   publication time, and `stable` or `beta` channel. Withdraw rather than delete
   old entries. A metadata-only renewal uses the same process without new assets.
4. Run **Publish reviewed module catalog** from main with that input path.
   The `module-publication` environment requires maintainer approval. It holds
   the dedicated Ed25519 signing key; the job uses GitHub's short-lived token
   scoped to this repository. It has no access to the private application source.
5. The workflow inspects new archives as data without executing their code,
   confirms immutable historical entries, publishes fully uploaded drafts, and
   advances the signed catalog using the previous content SHA. If publication
   succeeds but catalog advancement fails, inspect the state and rerun the same
   input; do not rebuild or replace existing assets.
6. Check the feed in Hubble2. Discovery and download must not reload a module.
   Activate only the intended connection/version using Apply and reload.

The catalog URL is
`https://raw.githubusercontent.com/Lightlab24/Hubble-Modules/main/catalog.json`.
Clients trust the public key embedded in their host build, not a key downloaded
alongside an arbitrary catalog. Key rotation requires a planned host update.
Keep the catalog's expiry current even when no module versions change.

The module catalog and the application's curated bundled-module lock are
independent. Inclusion in a downloadable application release remains a separate
maintainer decision. Do not publish an application release from this repository.
