# Reviewed dependencies for Hubble 2.0.7

This batch publishes four module archives plus SDK, tools and developer kit 1.2.0. Existing releases and historical archive identities remain unchanged. Catalog sequence 4 retains all 17 historical entries, withdraws the test-only Mock entry, and adds four production modules.

## Source provenance

The four module release tags must target source commit `56876a3f9e73b0a4f805751da5a81abcb6d6b7c9`:

- module-hubble-ccc-v1.1.0
- module-hubble-cyanview-rcp-v1.1.0
- module-hubble-http-requests-v1.1.0
- module-hubble-system-actions-v1.1.0

All four archives were rebuilt byte for byte against their exact reviewed Hubble pins using Node 22.22.2 and pnpm 11.0.8. The module build used the source commit's SDK contract snapshot, before optional hostEnabled and dataAccess fields were added. No module behavior source differs from the following SDK/kit commit.

The SDK release `sdk-v1.2.0` targets e98a9bbf6af97935179aa4dfd73ffb61bb225fcf. It adds optional hostEnabled and dataAccess SDK schema fields after the module source snapshot. The SDK archive is unchanged by the later kit repair.

The `tools-v1.2.0` and `developer-kit-v1.2.0` release tags target the repair commit containing this review update. The tool CLI resolves symlinked entry paths correctly. The independent API example supplies required action and feedback descriptions, and kit qualification requires each of its 18 commands to return the expected successful JSON result.

The earlier unpublished kit candidate was invalid: its example omitted descriptions, and the macOS builder silently skipped CLI calls through /var aliases. Clean Linux CI exposed the defect before publication. The tools and kit drafts must be replaced with the newly reviewed hashes; no published release is changed. SDK and the four module archives retain their original reviewed bytes. SDK/tools runtime dependencies are published npm packages, so no further Hubble distribution is required.

## Qualification

- Node 22.22.2, pnpm 11.0.8; frozen installation.
- SDK/tools build and all production module builds passed.
- Current SDK/kit source: 688 tests across 56 files, 31 author/tooling tests, and TypeScript passed.
- Earlier module source: 688 tests across 56 files and TypeScript passed; all four module archives matched their exact pinned bytes and SHA-256.
- Author distribution packaging and all 18 portable kit starter/example commands passed with command-specific result validation. CLI symlink execution and rejection of silent/wrong-status self-tests have focused regressions.
- Catalog signature was verified against the committed public key; the proposed update passes immutable-history and archive validation.
- No live hardware, installed applications, production profiles, or database was used.

## Protected publication

After source review, push these commits and merge them onto main. Stage all seven absent releases as drafts at their correct source commits using the exact verified archives. Download every staged asset and verify its reviewed digest before dispatch. Do not overwrite any published version.

Use the existing Publish reviewed module catalog workflow from main in `initial-release` mode with:

- pins: release-review/app-2.0.7/distributions.json
- catalog: release-review/app-2.0.7/catalog-input.json

This existing batch verifies all three standalone distributions, publishes them, then verifies all new module archives before publishing and signing catalog sequence 4. The module-publication environment restricts deployment to main and requires the Lightlab24 reviewer. Preserve that approval policy. No publication credential or signing key is stored in this review directory.
