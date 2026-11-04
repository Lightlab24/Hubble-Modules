# Package-owned custom pages

API 1 custom frontends require `module-custom-pages-v1` and Hubble 2.0.11+.
Developer kit 1.8.0 / SDK 1.8.0 also supports full-page layout on Hubble 2.0.18+.
Use the actual service's `describe` response to verify the required features.

## Full-page application layout

Set `pages[].layout` to `"full-page"` and declare exactly one `custom` section.
Add `module-custom-pages-full-page-v1` to the existing host requirements and set
`host.minimumVersion` to at least `"2.0.18"`. Keep the page service capability and
base page/frontend features:

```ts
host: {
  minimumVersion: '2.0.18',
  requiredFeatures: [
    'module-pages-v1',
    'module-custom-pages-v1',
    'module-custom-pages-full-page-v1',
  ],
},
capabilities: ['service.page.designer'],
pages: [{
  id: 'designer', label: 'Designer', layout: 'full-page',
  sections: [{
    type: 'custom', id: 'app', label: 'Designer application',
    entry: 'ui/index.html',
    commands: [{ id: 'render', label: 'Render preview' }],
  }],
}],
```

The iframe fills the bounded app content area beside Hubble's sidebar and resizes
with its container. No pixel `height` is required; that section field is ignored
in full-page mode. Hubble omits the page heading, description, autosave status,
section heading and related-setup footer, and adds no padding. The module owns its
header, tabs, footer and internal scrolling. The sidebar and app window controls
remain host-owned. Disabled/error messages remain available when the frontend
cannot run.

Use `html, body, #root { height: 100%; margin: 0; }` and a bounded flex or grid
layout with `min-height: 0` and `overflow: auto` on the intended internal scroll
area. A height based on `100vh` inside the iframe also refers to that iframe's
viewport, not the complete Hubble window. See `examples/full-page` for a working
header/tabs/long-content/footer layout and scoped backend calls.

Any explicit `layout` value requires Hubble 2.0.18+ and the new feature, including
`"sections"`. Omit the field for compatibility with older hosts. Omitting `layout`,
or specifying `"sections"` on a compatible host, retains the current host headings
and fixed section `height` (default 560px). Mixed custom/native pages continue to
use sections; see the unchanged `custom-canvas` example for composition with the
actual shared Matrix workbook. Full-page layout does not add permissions or
change `sandbox="allow-scripts"`, the scoped MessagePort bridge, session tokens,
heartbeat, tab cleanup or package-generation invalidation. Keep browser assets
and all integration-specific UI inside the package.

## Declare and build

Add a `custom` section to a normal page. Require both `module-pages-v1` and
`module-custom-pages-v1`, and declare `service.page.<pageId>` in capabilities.

```ts
{
  id: 'designer', label: 'Designer', sections: [
    {
      type: 'custom', id: 'canvas', label: 'Canvas', entry: 'ui/index.html',
      height: 560, commands: [{ id: 'render', label: 'Render preview' }],
    },
    // A normal table section with workbook/stateKey uses the actual host Matrix.
  ],
}
```

The HTML and every asset must be in the immutable package's `files` list under
`ui/`. The portable tool builds browser entries separately from the Node worker:

```json
{
  "hubble": {
    "assets": ["ui/index.html"],
    "frontend": { "ui/app.js": "src/frontend.ts" }
  }
}
```

Use an external `<script type="module" src="app.js"></script>` in the HTML.
Imported CSS and supported assets are included in `files` automatically. Link a
generated stylesheet from HTML. React or another framework may be bundled through
the project's dependencies. Inline scripts, runtime CDN imports, Node imports,
remote requests, nested frames, popups and direct device access are unavailable.
Keep device and OS operations in the backend and supported host services.

## Scoped bridge

```ts
import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
const page = await connectModuleFrontend(window);
const stop = page.subscribe((state) => {
  /* public ModuleState or null */
});
const result = await page.call("render", { text: "Camera 1" });
// On page disposal:
stop();
page.dispose();
```

The backend receives `instance.call('page.designer',
{ sectionId: 'canvas', commandId: 'render', value }, context)`. Validate the
command's values in module code. Hubble validates the declared command, selected
package, instance, workspace and worker generation. The public state subscription
contains the worker's published state (up to 256K characters); never publish credentials. `page.state()`
requests the latest state. Commands have JSON inputs/results up to 256K characters,
at most 32 pending requests and a 120-second deadline. Reject invalid values with
an error and preserve the user's editable draft in the frontend.

The bridge supplies no caller-controlled scope or private desktop API. Closing,
disabling, updating or changing workspace revokes the session and aborts its
pending backend requests. Backend operations must honor `context.signal`; an
already completed device operation cannot be undone by closing the page. Opening
or receiving state never automatically executes a command. A page reload may
replace its message port; late replies are not delivered to its new document.

Frontend assets are verified against the selected package archive. Each session
serves only supported static `ui/` files, up to 16 MiB total, subject to existing
package limits. The host allows 8 pages per instance, 32 overall, 64 MiB overall,
and expires abandoned sessions after 30 minutes. The renderer renews active
sessions. These temporary capabilities and ports are not workspace data.

## Shared Matrix and acceptance

Compose a normal `table` section alongside the custom section, declaring
`workbook`, stable `stateKey`, column editors/formulas/fill rules and restrictions.
The host supplies its real Matrix controls; never copy the grid into the iframe.
Declare the package's Matrix action/feedback definitions separately and share
backend functions with the custom page. The example demonstrates this pattern.

Use [portable documents](documents.md) to share saved values between the canvas,
host workbook and backend actions. The example's title, rows, formulas and layout
share one document; its preview counter is transient. Its source picker uses
[shared datasets](datasets.md), and its preview backend uses a package-owned
[helper](helpers.md). See their contracts for permissions, lifecycle and limits.

Qualify frontend commands and errors, typing through state updates, navigation,
package replacement/removal, stale sessions, scope isolation, held saves and
history ownership. Compare Matrix and module workbook controls in the full
renderer. Simulation of native menu dispatch is not an actual macOS menu test.

## Spreadsheet controls in a bespoke layout

Use the host [spreadsheet controls](spreadsheet-controls.md) when the module owns
the grid layout and needs the Matrix choice editor, range selection, quoted TSV
clipboard or fill. This smaller surface composes with the full native workbook.
