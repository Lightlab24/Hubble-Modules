# Reviewed dependencies for Hubble 2.0.7

This batch publishes four module archives plus SDK, tools and developer kit 1.2.0. Existing releases and historical archive identities remain unchanged. Catalog sequence 4 retains all 17 historical entries, withdraws the test-only Mock entry, and adds four production modules.

## Source provenance

The four module release tags must target source commit `56876a3f9e73b0a4f805751da5a81abcb6d6b7c9`:

- module-hubble-ccc-v1.1.0
- module-hubble-cyanview-rcp-v1.1.0
- module-hubble-http-requests-v1.1.0
- module-hubble-system-actions-v1.1.0

All four archives were rebuilt byte for byte against their exact reviewed Hubble pins using Node 22.22.2 and pnpm 11.0.8. The module build used the source commit's SDK contract snapshot, before optional hostEnabled and dataAccess fields were added. No module behavior source differs from the following SDK/kit commit.

The SDK, tools, and kit release tags target this following commit, which adds those two optional SDK schema fields:

- sdk-v1.2.0
- tools-v1.2.0
- developer-kit-v1.2.0

SDK and tools were freshly packaged from that exact source. Their dependencies are published npm packages; no additional unpublished Hubble assets are needed. All 843 regular files emitted by the rebuilt developer kit match the pinned kit byte for byte. The pinned kit additionally contains a generated pnpm esbuild shim with the build machine's NODE_PATH; the portable CLI does not use it. Tar metadata and this generated shim prevent byte-identical kit repacking, so the original reviewed kit archive is preserved exactly.

## Qualification

- Node 22.22.2, pnpm 11.0.8; frozen installation.
- SDK/tools build and all production module builds passed.
- Current SDK/kit source: 688 tests across 56 files, 28 author/tooling tests, and TypeScript passed.
- Earlier module source: 688 tests across 56 files and TypeScript passed; all four module archives matched their exact pinned bytes and SHA-256.
- Author distribution packaging and the portable kit's isolated starter/examples build/test/validate checks passed.
- Catalog signature was verified against the committed public key; the proposed update passes immutable-history and archive validation.
- No live hardware, installed applications, production profiles, or database was used.

## Protected publication

After source review, push these commits and merge them onto main. Stage all seven absent releases as drafts at their correct source commits using the exact verified archives. Download every staged asset and verify its reviewed digest before dispatch. Do not overwrite any published version.

Use the existing Publish reviewed module catalog workflow from main in `initial-release` mode with:

- pins: release-review/app-2.0.7/distributions.json
- catalog: release-review/app-2.0.7/catalog-input.json

This existing batch verifies all three standalone distributions, publishes them, then verifies all new module archives before publishing and signing catalog sequence 4. The module-publication environment restricts deployment to main and requires the Lightlab24 reviewer. Preserve that approval policy. No publication credential or signing key is stored in this review directory.
