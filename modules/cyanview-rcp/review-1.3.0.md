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

## Evidence

Candidate digest `77d2463320f5f98edb1ac997ceb2331d6a3709722d01eefaf4e42f6e141bf25c`. The full record is
`docs/testing/cyanview-rcp-switching-only-2026-11-07.md` on Hubble's `claude/reverent-goldstine-a6412d` branch.

**Source.** The module and CCC test suites and every `check.yml` step pass.

**Real host.** The package in Hubble's real module host, as a real worker, against a fake MQTT broker, with
nothing else installed: 3 of 3. The refusal test fails on the shipped 1.2.3.

**Side build.** The real Electron app and renderer from Hubble `4195a9e9`, on isolated ports with a temporary
profile: the spec passes 4 of 4 with this package and fails 4 of 4 on 1.2.3. A module-only update from 1.2.3
with a saved record-camera row also passes.

**Not done.** Nothing here has run against a physical RCP. This package isn't published.
