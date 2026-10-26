# Source and qualification

Start with `module-tool create`, then explicit `build`, `test`, `validate`, `pack`
and `inspect`. Read `src/`, not the generated bundle. `package.json` is the single
identity/version source; manifest composition is typed code executed only by build.
Use separate config, action families, feedback, instance lifecycle, protocol codec,
transport and state files where the module has those responsibilities. `index.ts`
assembles them. Shared packages have a named protocol or contract responsibility.

`createActionRegistry` requires descriptors and handlers to share exact IDs and
checks completion evidence. Keep IDs and their meanings stable. Label/group changes
are presentation; removing or repurposing a saved action/field/choice is a breaking
contract even if `configVersion` changes. API 1 has settings migration only.

Use `@hubble/module-sdk/testing` for real SDK-shaped contexts, instance isolation,
pre-dispatch cancellation and repeated disposal. Extend it with fake-device tests
for startup/reconnect without control writes, in-flight cancellation, timeout/no
replay, partial-start cleanup, accurate acknowledgment/readback and stale feedback.
The generic harness cannot prove protocol behavior without those observations.
Use canary secrets in diagnostic/error/state tests; host log redaction is limited
to exact declared secret values and is not a substitute for safe module logging.

Before a release: build from a clean public checkout; run affected protocol and
module tests, typecheck, compare prior descriptors/saved non-default fixtures, and
test the exact archive against an unchanged compatible host. Inspect the explicit
runtime file allowlist and retain third-party notices. Normal module changes must
not add private Hubble imports, new host action enums or app build dependencies.
New host features require a separate compatible app release and declared minimum.

The app bundles immutable published archives selected by URL, size and digest.
Per-module candidate CI has no publishing credentials. Reviewed publication verifies
the exact archive, immutable release identity and signed catalog before announcing
availability. Do not replace release bytes under an existing version. Source tests,
package validation, publication and activating hardware remain distinct operations.
