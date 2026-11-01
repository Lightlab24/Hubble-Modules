# Workspace module instances

Candidate contract: API 1, `module-workspace-instances-v1`, minimum Hubble 2.0.11.
Developer kit 1.5.0-dev.9 includes this declaration and the workspace-scoped
`custom-canvas` example. Installed 2.0.10 does not provide generic workspace
instances. Check the target host before selecting a package.

## Declare the scope

```ts
export default defineModuleManifest({
  // The usual identity, actions, settings, pages and other fields also apply.
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: ["module-workspace-instances-v1"],
  },
});
```

Use workspace scope for a workspace-wide tool or workflow that does not represent
a physical connection. The host offers it in Add module, saves its selected
package/settings and automatically registers its declared pages, actions and
feedback. A compatible ordinary package needs no new Hubble enum or sidebar
branch. Its backend receives `{kind:'host', workspaceId, capabilityId: moduleId}`.
This contract provides **one instance per module ID per workspace**. A package
can model multiple designs or other domain entities inside its documents. Use
connection scope for independently configured device instances.

An omitted `instanceScope` retains the existing connection-package contract.
`instanceScope: 'connection'` makes that intent explicit. The historical built-in
workspace scopes `ccc` and `system-actions` retain their old identities and
compatibility behavior. Do not rename them or duplicate their saved data merely
to adopt the new declaration. `mock` remains inert test compatibility and is
prohibited in production.

## Identity, persistence and lifecycle

Workspace packages use the same public actions, Matrix, page, document, dataset,
helper and permitted peer APIs. Workspace scope grants no automatic access to
other modules or Hubble data. Request the same explicit permissions. It also does
not grant legacy CCC, router or application-specific private host services.

The instance is identified by workspace and stable module ID. Package version,
digest and worker generation remain distinct. A package cannot bind another
module's workspace identity. Selecting a workspace-only package as a connection
is rejected. Upgrades must retain scope; changing an existing package from a
connection to a workspace requires an explicit data/reference migration and is
not performed automatically by this contract.

Enabling, disabling, removing, updating and re-adding use the common lifecycle.
Removal revokes the worker, pages, sessions and helpers. Saved module documents
remain under their original owner. Re-adding the same module ID in that workspace
can read them; it cannot silently reset them. Removing a binding clears that
selection/settings; export before removal if those settings must be restored.
Use portable documents for retained domain content, not worker scratch storage.
Workspace bindings, settings and documents participate in workspace transfer and
duplication. Matrix action bindings retain the same scope through full-workbook
clipboard transfer. Source links and process generations remain local.

The host supports at most 64 stored workspace binding keys, including retained
removed keys and legacy keys. Imported older files without extra keys continue
to use their legacy defaults. Missing or incompatible selected packages must be
reported as unavailable without replacing them with another module.

## Acceptance

Build outside Hubble from the public kit. Add/select a previously unknown package
without a device connection and exercise settings, its real host-rendered
workbook, custom frontend and backend action. Hold an add/save unresolved, make a
second edit and an unrelated edit, then reject the first save. Dependent changes
must roll back while unrelated work survives. Test disable/remove/re-add, version
replacement and rollback, stale sessions, helper cleanup and cross-workspace
isolation. Qualify non-default bindings/documents through export/import/re-export,
replacement modes, full Matrix clipboard and real-worker restart.

Offline tests do not establish package-only updates against unchanged installed
Hubble/HubDash bytes or actual native/device acceptance. Record those separately.
