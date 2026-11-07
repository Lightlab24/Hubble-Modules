# Custom canvas and native workbook

Build and test with the public developer kit:

```sh
node /path/to/kit/module-tool.mjs build .
node /path/to/kit/module-tool.mjs test .
node /path/to/kit/module-tool.mjs pack . custom-canvas-0.1.0.hubble-module
```

Requires the candidate Hubble 2.0.11 `module-custom-pages-v1` capability. The
package owns the HTML, CSS, canvas, browser code and backend preview behavior.
The adjacent workbook uses the host's real Matrix surface. Button Matrix's
declared Render action uses the same backend function as the canvas preview.
The package declares `instanceScope: 'workspace'` and
`module-workspace-instances-v1`; add it from the module library without creating
a device connection. Each workspace has its own instance and saved design.

The example does not control hardware. Its preview counter is transient.
The title and workbook rows/formulas/layout share a revisioned portable document
through `host.documents` and `module-documents-v1`. Sidebar and Matrix actions read
that same document. The example keeps typing responsive while saves are pending
and rebases only disjoint revision conflicts. Its document watch retries with
bounded backoff and shows only a failure that lasts. Its source picker uses
`host.datasets` and `module-datasets-v1`, with explicit operator read grants for
shared Hubble or other-module data. Its own Label data table is also a declared
dataset. Link one cell, edit its workbook value, and preview again: the canvas and
an action without a text override use the same saved reference. Removing the source
row reports an error and retains the link for correction.

The preview backend uses `host.helpers` and `module-helpers-v1` to start the
package's separately bundled `helpers/renderer.mjs`. Both sidebar and Matrix
actions use it. It targets standalone Node 22 on macOS/Linux arm64/x64; it does
not depend on a system Node installation. The host owns readiness, cancellation
and package/generation cleanup. The package owns the rendering behavior in
`src/render-label.ts`. No device commands are sent by this example.
