# Local tools and handoff

Discover the kit's `module-tool.mjs` next to its `README.md`. In a source checkout,
use `pnpm build` and `node tools/module-tool.mjs` in Hubble-Modules. The app checkout wrapper consumes its pinned published kit.
The standalone kit requires Node 22 or newer and no private repository access.

```text
node <tool> create <new-project-directory> <module-id>
node <tool> build <project-directory>
node <tool> validate <project-directory>
node <tool> test <project-directory>
node <tool> pack <project-directory> <new-output.hubble-module>
node <tool> inspect <package.hubble-module>
```

The tool emits JSON and nonzero failure exit codes. `create` and `pack` refuse
existing destinations. `validate`, `pack`, and `inspect` do not execute module
JavaScript. `test` executes the author's Node tests with a deadline; this is trusted
code execution, not a sandbox. Inspect a supplied package before choosing to run
its code. Do not execute unreviewed install scripts or infer official provenance
from a filename or digest.

For a new module, create a source project, replace the simulated behavior with the
requested integration, and add relevant tests. The standard TypeScript build composes typed descriptors into
`dist/hubble-module.json` and bundles `src/index.ts` into `dist/module.mjs`.
Legacy root-manifest JavaScript projects still need no compile step. Test against simulation or a user-designated test target,
validate, then produce a versioned archive. The file allowlist determines what is
shared; include no credentials or machine-specific paths.

For an existing module, preserve IDs and supported configuration, run its focused
tests, validate and package the changed build. Keep prior packages for comparison
and eventual rollback. For someone else's finished package, `inspect` can verify
contents and descriptors without running it.

Use the shipped `service-client.mjs` (source checkout: `packages/module-tools/dist/service-client.mjs`):

```text
node <client> --url http://127.0.0.1:42841 describe
node <client> import <project-folder-or-package>
node <client> link <workspace-uuid> <connection-uuid> <project-folder>
node <client> reload <workspace-uuid> <connection-uuid>
node <client> logs <workspace-uuid> <connection-uuid>
node <client> host-link <workspace-uuid> <ccc|system-actions|mock> <project-folder>
node <client> host-reload <workspace-uuid> <ccc|system-actions|mock>
node <client> host-logs <workspace-uuid> <ccc|system-actions|mock>
node <client> reload-all <workspace-uuid>
node <client> request <operation.json>
```

Pass `--url` on every command when targeting an origin other than Hubble2.
Protected services accept `--password-file PATH`; do not put passwords into logs.
`request` accepts the API's JSON operations, including `select`, `rollback`,
`download`, `check-updates`, `choices`, and `cleanup`. Inspect `describe` first.
Select includes workspaceId, connectionId, exact identity (moduleId,version,digest),
pinned and expectedDraftRevision. Rollback includes the same scope and revision.
Download includes only the exact identity. Neither import nor download activates.

Create custom connections in Module Library using Add connection and its generated
settings form. Configure actions in the workbook's module action editor. New
manifest actions appear after selecting/reloading their build. Source links are
local to one workspace connection; `reload` snapshots the current built project.
Saving or building alone never changes the running generation. Opted-in stable
updates are downloaded in the background and applied only at the next service
startup; beta remains manual and a pinned selection wins over automatic policy.

Verify the resulting selected identity, runtime generation, ready/unavailable
state, and observed logs. Offline hardware can remain unavailable after a correct
reload. Workers are failure isolation, not an OS sandbox: only run trusted code.
On a failure, inspect current state before retrying. Sent device commands are not
replayed. Reload all affects only enabled external modules in the named active
workspace, and can briefly interrupt those connections; the service stays up.

Version migration uses optional `migrateConfig(settings, fromVersion, toVersion)`.
It returns data without contacting hardware. On schema-changing rollback, the host
restores the recorded previous settings only if the migrated settings were not
subsequently edited. Otherwise export the edits and resolve the version explicitly.

Sharing means producing the source and `.hubble-module` archive. GitHub submission
and official publication are separate actions governed by the maintainer's review
workflow. Do not publish from a request to build or package.

Workspace module operations use `capabilityId` instead of `connectionId`:
`host-select`, `host-rollback`, `host-link`, `host-unlink`, `host-reload`,
`host-logs`, and `host-open-folder`. Select/rollback use the same revision and
identity guards as device modules. `list` includes `hostSelections`. Reload all
includes enabled workspace capabilities as well as device connections.

To add an action to a built-in device module, keep its existing implementation and
manifest legacy actions, add a new descriptor with fields and a stable ID, and
handle that ID in the module's `execute` hook. Bundle only the changed module,
import/link and select its build, then add a generic **Module action** column using
the existing connection. The editor discovers the new action from that selected
manifest. Existing device-specific columns continue using their saved IDs. Test
both paths; do not change the host action enum or rebuild the service just to add
that descriptor and handler. An action needing a new host capability still needs
an explicit compatible host update.
