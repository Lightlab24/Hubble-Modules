---
name: hubble-module-author
description: Build, edit, validate, test, and package native Hubble modules with the matching developer kit. Use for Hubble integration authoring, not for Companion plugin development.
---

# Hubble module author

Read the developer kit’s `README.md` and `kit.json` first. SDK/tool release versions
are independent of module versions and API 1. Choose a supported API, minimum full
Hubble version and required host features; do not equate an SDK update with an app requirement. Use `service-client.mjs describe` to discover
the actual host capabilities, product, active workspace, storage paths, and exact
version selections. Default test origin is http://127.0.0.1:42841. Never assume
that production Hubble is the target. A source build or package import does not
activate code; apply/reload is explicit.

Read [the contract guide](references/contract.md) when defining settings, actions,
feedback, or lifecycle behavior. Read [the workflow guide](references/workflows.md)
for tool invocation, package inspection, or handoff.

Create the multi-file TypeScript starter. Keep editable source in the user's chosen project folder. The suggested default
is `~/Documents/Hubble Modules/<module-id>/`. Installed packages will belong to the
service computer's product-specific storage; do not edit app bundles, registry
files, or SQLite to install one. Hubble module projects do not belong in Companion's
module directories.

Preserve stable module, action, feedback, and field IDs. Keep device-specific
features and completion semantics; a generic interface must not flatten protocol
differences. Document intentional migrations instead of silently changing saved
actions. Built-in protocols run in external workers while retaining their existing
clients and saved IDs. CCC, system actions, and mock actions use explicit workspace
host scopes; other integrations use physical-connection scopes.

Import/validation, activation/reload, and device-action testing are distinct.
Carry the user's authorization through the requested workflow without repetitive
approval prompts. A request to edit or install does not authorize commands to live
devices. Use simulation or an explicitly designated test device/workspace.

Report the concrete output path, module/version, tests run, and whether code was
merely packaged, installed, or actually activated. Do not equate device-offline
status with invalid code. Building a package does not submit or publish it.

For source organization, descriptor composition and release qualification, read
[the authoring guide](references/authoring.md). Official modules and reusable protocol
libraries live in the public Hubble-Modules repository. Build and test a module
there without a private Hubble checkout. A generated `module.mjs` may be large;
never move maintainable source back into it or hide a god file in a shared package.
