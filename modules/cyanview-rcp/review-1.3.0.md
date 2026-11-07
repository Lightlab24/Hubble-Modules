# CyanView RCP 1.3.0 qualification

This package now only switches the current camera. Camera control belongs in the Cyanview module. Before
this, Record Camera called CCC's `record-rcp` and needed an approval that no screen in Hubble can grant.

Module API 1, saved action IDs and host requirements are unchanged, and Hubble's automatic-update contract
check accepts 1.2.3 to 1.3.0. Switching uses the same manager and MQTT subscription as 1.2.3.

## Behaviour that changes

- The package no longer calls CCC.
- The Action dropdown offers only Select camera.
- A row saved with a recording action shows a validation error and sends nothing. The rest of the workspace
  isn't held back. A direct call to one of those actions refuses.
- The `recordCamera` and `recordGroupAll` services are no longer declared.
- The archive no longer contains the shared protocol's blind recording commands, including the All-group
  broadcast topic. Nothing called them, and this removes the bytes.

## Evidence

Candidate digest `8bd1d08dafe9a2306f39a9c6b9664cde683210b19936d46f151465a15e0ebfde`, 327,476 bytes. Don't use the
earlier `77d24633`: its archive still contains `camgroup` and `RecToggle`. The full record is
`docs/testing/cyanview-rcp-switching-only-2026-11-07.md` on Hubble's `claude/reverent-goldstine-a6412d` branch.

**Source.** The module and CCC test suites and every `check.yml` step pass on this tree.

**Real host.** The package in Hubble's real module host, as a real worker, against a fake MQTT broker, with
nothing else installed: 3 of 3. The refusal test fails on the shipped 1.2.3.

**Side build.** The real Electron app and renderer from Hubble `4195a9e9`, on isolated ports with a temporary
profile: the spec passes 4 of 4 with this package. Its control on 1.2.3 fails 4 of 4, from an earlier run. A
module-only update from 1.2.3 with a saved record-camera row also passes.

**Not done.** Nothing here has run against a physical RCP. This package isn't published.

The blind 1.0.0 releases of `hubble-cyanview-rcp` and `hubble-ccc` were withdrawn separately, at catalog sequence
11, so a catalog input for this release has to be made from there.
