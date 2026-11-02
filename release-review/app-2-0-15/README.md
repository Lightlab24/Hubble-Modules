# Reviewed dependencies for Hubble 2.0.15

This batch publishes 15 official module versions, SDK 1.7.0, tools 1.5.0 and
developer kit 1.7.0. Catalog sequence 6 retains all 22 historical entries, including
the withdrawn Mock entry, and adds the inspected production archives. Published
versions and archive bytes must not be replaced.

## Exact module provenance

Every module archive was reconstructed from its currently selected installed
manifest and declared runtime files. The resulting archive digest exactly matches
the installed identity. `module-artifacts.json` records those identities, lengths
and immutable URLs. No operator workspace, settings, runtime state or credentials
are included in an archive. DataQ is a separate custom package and is not part of
this official publication batch.

The reviewed source baseline is `d747e0cf7aebdf8102b2770dacc56f7ca3f5ae93`.
Its public GitHub check passed SDK/tools, all module builds, protocol tests,
TypeScript, author distributions, the host bridge and portable kit examples:
https://github.com/Lightlab24/Hubble-Modules/actions/runs/41483658741.
Module release tags target the main commit containing this review. The archive
digests, rather than a rebuild of an older local candidate, identify delivered code.

## Verification scope

The latest router propagation passed 243 public runtime/protocol tests, 19 real
browser scenarios, five real-worker lifecycle cases, 54 renderer assertions and
type/lint checks. AJA, Evertz and Blackmagic 1.1.3 were selected while their
connections remained disabled; both installed host file/link trees were unchanged.
The preceding CCC/Tally/Ross changes passed their focused tests and installed
checks, as recorded in Hubble's 2026-11-02 verification reports. Earlier extraction,
input/fill and persistence qualification remains recorded in those source reports.

Native/physical-device acceptance is separate from source, loopback and renderer
qualification. This publication does not claim every integration's full independent
lifecycle or physical hardware verification is complete. No device command was
performed to manufacture a release test result.

SDK/tools archives use their existing independent release versions. The stable
1.7.0 kit retains the dev.6 contracts and updates its own version/documentation.
Its standalone exported examples were built, tested and validated again. The
three exact distribution pins are listed in `distributions.json`.

## Protected publication

Stage all 18 absent releases as drafts at the reviewed main commit. Download and
verify every staged asset against these pins and catalog entries before dispatch.
Existing published versions are immutable. Preserve the required-reviewer and
main-branch policies on the `module-publication` environment.

Dispatch **Publish reviewed module catalog** from main once in `initial-release`
mode with:

- `pins`: `release-review/app-2-0-15/distributions.json`
- `catalog`: `release-review/app-2-0-15-catalog.json`

The job verifies all three distributions before publishing them, then verifies all
new module archives before publishing and signing the catalog. Hubble's separate
release pipeline consumes the verified URLs and creates its signed/notarized
application artifacts. No forced application update is requested.
