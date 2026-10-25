# Contributing a Hubble module

Use the public TypeScript starter and [developer guide](docs/developer-kit.md).
Official source lives in `modules/<name>/`; shared packages have focused protocol
or contract ownership. Community proposals can use `submissions/<module-id>/` or
link an independent repository and exact commit in a submission issue.

A source submission includes identity/version in `package.json`, typed descriptors,
focused implementation files, fake-device tests, and equipment/configuration notes.
Retain dependency licenses and declare the contribution license. Do not include
credentials, real workspace exports or private device logs. Legacy JavaScript
projects with `hubble-module.json` and `module.test.mjs` remain accepted.

Before review, build, typecheck, test, validate and package. Compare representative
saved settings/actions with the previous release. Preserve action/feedback/field IDs
and their meaning; settings migrations do not migrate workbook actions. Confirm
startup/reconnect sends no controls, cancellation reaches waits/transport, uncertain
commands do not replay, disposal cleans partial starts, feedback becomes unavailable
when stale, and logs/errors contain no secrets. Test against simulators; CI must not
contact real equipment or require credentials.

Keep module code independent of private Hubble source. New actions within the
supported public contract must not require an app build. New host features require
an explicit declared minimum host version and separate host implementation.

Candidate builds do not publish or activate code. Maintainers review exact bytes;
official catalog publication and inclusion in an app's bundled lock are separate.
