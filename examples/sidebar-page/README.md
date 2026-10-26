# Module sidebar page example

`example-sidebar` 1.0.1 requires Hubble 2.0.2 and `module-pages-v1`.
It demonstrates a sidebar screen with a settings form, an editable spreadsheet,
and status published by its worker. It opens no sockets and controls no hardware.

From the public repository:

```sh
pnpm build
node packages/module-tools/dist/module-tool.mjs build examples/sidebar-page
node packages/module-tools/dist/module-tool.mjs test examples/sidebar-page
node packages/module-tools/dist/module-tool.mjs pack examples/sidebar-page artifacts/example-sidebar-1.0.1.hubble-module
```

Import the archive, then add an External Module connection using that package in
an isolated test workspace. `Camera setup · <connection name>` appears in the
sidebar. Changing its settings or rows updates `context.settings` on its next
instance. All table rows, values and order travel with workspace exports.

Change labels, columns, sections or add another page in `src/manifest.ts`, bump
this example's version, rebuild and select it to test a module-only UI update.
Keep page IDs, table IDs, column IDs and their meanings stable. Use `migrateConfig`
when changing saved settings semantics. Merely opening a page never calls an action.

The supplied `set-state` action remains a local simulator action. It can be used
from the existing Module actions entry in Button Matrix; it is separate from
editing page settings or table cells.

In the standalone developer kit replace `packages/module-tools/dist/module-tool.mjs`
with `module-tool.mjs`; no package installation is needed.
