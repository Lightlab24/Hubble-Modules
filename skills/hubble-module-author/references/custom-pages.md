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

## Show a frontend in module settings

Add `placement: "module-settings"` to a page to show its custom section with the
connection's settings instead of in the sidebar. Require
`module-settings-pages-v1` in addition to the normal custom page features; a host
without it refuses the package. Such a page belongs to a connection, contains only `custom` sections,
and cannot declare `layout` or `navigation`. Omit `placement`, or use `"sidebar"`,
for a normal sidebar page.

```ts
{
  id: 'routing-settings', label: 'Routing', placement: 'module-settings',
  sections: [{
    type: 'custom', id: 'routing-settings', label: 'Routing',
    entry: 'ui/settings.html', height: 72,
    commands: [{ id: 'read', label: 'Read' }, { id: 'write', label: 'Write' }],
  }],
}
```

Declare `service.page.<pageId>` as usual. Use this when a control's value lives in
a module document, so a settings field would create a second saved copy. A
frontend saves on its own schedule rather than with **Save changes**; say so in
its text. It uses the same sandbox and scoped bridge as any other custom page.
`height` can be as low as 48 for a single settings row.

## Save the module's settings from a page

A page a module draws can show the module's own settings and save them, so a setup page
need not send the operator to Module Connections. List the settings the page may save on
its `custom` section and require `module-frontend-settings-v1` (Hubble 2.3.1):

```ts
{
  type: 'custom', id: 'app', label: 'Setup', entry: 'ui/index.html',
  commands: [{ id: 'snapshot', label: 'Read the page' }],
  settings: ['protocol', 'transport', 'port'],
}
```

```ts
const page = await connectModuleFrontend(window);
await page.saveSettings({ protocol: "5.0", port: 9821 });
```

- Each ID is one of the module's declared `settings`, and never a secret. Hubble refuses a
  save that names any other setting, as a whole, and saves nothing.
- Settings you leave out keep their values. Hubble checks the result the way its own
  settings form does, and an invalid value is refused with the form's message.
- The save is Hubble's ordinary settings save: shown at once in Module Connections, saved in
  order behind any save still on its way, and rolled back with Hubble's fading toast when
  the workspace refuses it.
- **A saved setting restarts the module.** Show the new value the moment the operator makes
  the change and never wait on `saveSettings` to draw it. Save several values in one call
  rather than one call each, and hold a typed value until Enter or leaving the box.
- **Hubble then reloads the page, unless the section stays open.** A reload two or three
  seconds after a change blinks the page, loses text being typed, and shows a second change
  as put back until its own reload. Declare `restart: 'keep-open'` as described under
  [Stay open while the module restarts](#stay-open-while-the-module-restarts) for any page
  an operator edits. A page that reloads keeps what it must still show afterwards, such as
  the open tab, in the backend's `runtimeDirectory` or a module document.
- The backend reads the saved values from `context.settings` when it starts, as always.
  Hand them to the page in the reply to its first command.
- A `module-settings` page cannot save settings this way: its settings already sit beside it
  with their own **Save changes**. `saveSettings` rejects there, and on a Hubble without the
  feature.

Use this only for settings that already belong to the module. A value an operator changes
while a device runs belongs in a page command or a module document, which do not restart
the module.

## Stay open while the module restarts

Hubble ties an open page to one run of its module. When the module restarts, Hubble closes
the page and loads it again. A section can ask to stay open instead, with
`restart: 'keep-open'` and `module-frontend-restart-v1` (Hubble 2.3.1):

```ts
{
  type: 'custom', id: 'app', label: 'Setup', entry: 'ui/index.html',
  commands: [{ id: 'snapshot', label: 'Read the page' }],
  settings: ['protocol', 'transport', 'port'],
  restart: 'keep-open',
}
```

```ts
import {
  connectModuleFrontend,
  MODULE_RESTARTING_MESSAGE,
} from "@hubble/module-sdk/frontend";

const page = await connectModuleFrontend(window);
page.onRestart(() => void readEverythingAgain());
```

- The frame, its scroll position, focus and typed text are untouched. The page's own files
  keep loading from the same address.
- While the module is between two runs, every `call` fails with `MODULE_RESTARTING_MESSAGE`
  ("Module is restarting"), and calls the stopped run had not answered fail the same way.
  Ask again shortly, or after `onRestart`. Do not repeat a command that changes a device
  without the operator: let it fail and say so.
- `onRestart` fires once the module answers again. Read everything from the backend again,
  because what the page holds came from the run that stopped. Redraw in place and leave the
  box in use alone.
- After `saveSettings` resolves, do not wait for `onRestart` to carry on. Hubble's window can
  hear of the new run a little late. Ask the backend for its settings until they are the
  ones you saved, then draw from that answer.
- A place the page keeps in the backend's data, such as the cursor of a long poll, belongs to
  one run. Hand it back with something that names the run, and treat another run's place as
  no place at all. Two runs count from zero and their numbers can agree by accident.
- Keep a settings save and any command that talks to a device apart: the restart cuts short
  a command still running. Hold the save until the command ends, and hold commands while the
  module restarts.
- The page stays only for a restart of the same package with the module coming back. A
  version change, a disabled connection or a module that failed to start closes it, as
  before. If Hubble no longer has the page's session it loads the page again.
- Hubble's window hears of a new run a moment late. A page that stays open is opened on
  whichever run is up, so leaving it and coming straight back after a save works. A page
  that reloads is refused until the window has caught up, as before.
- A page without `restart: 'keep-open'` is reloaded for every restart, as before.

## Open in several windows

HubDash can show a module's page in a window of its own, beside the main window, and the
operator can have the same page on screen in both. Hubble keeps a page that was not built
for that live in one window at a time: the other window shows a notice and a **Use it here**
button. Once the page is built so that several copies can be open at once, declare
`windows: true` on the section and require `module-page-windows-v1`:

```ts
{
  type: 'custom', id: 'app', label: 'Cameras', entry: 'ui/index.html',
  commands: [{ id: 'snapshot', label: 'Read the page' }],
  windows: true,
}
```

Every copy is its own frame with its own bridge, and all of them talk to the one running
module. Before declaring it, make sure of these:

- A copy never saves what it read when it opened over what another copy saved since. Send
  each edit as a change (this row, this field) that the backend applies to a fresh read, not
  the whole document as the page last saw it.
- Each copy follows the others. Publish a revision in the module's state when saved data
  changes, and have the page read again when it sees a new one, leaving the box in use alone.
- A refused edit puts back only that edit, and the copy then holds the current data, so the
  next edit is not refused for the same reason.
- What a copy is looking at (its tab, sort, scroll, selection) is that copy's own. Keep it out
  of the shared data, or two windows drag each other around.
- Limits the backend counts per instance, such as long polls or transfers in progress, allow
  for as many copies as there are windows.

### Open part of the page in its own window

A page with `windows: true` can open a part of itself in another window and name it:

```ts
const page = await connectModuleFrontend(window);
if (page.view === null) drawEverything();
else drawOnly(page.view); // "camera-3"

openButton.hidden = !page.canOpenWindows;
openButton.onclick = () => void page.openWindow("camera-3", "Camera 3");
```

- `openWindow(view, title)` opens the same page file in a new HubDash window. `view` is
  yours to choose, up to 128 characters, and arrives as `page.view` in that window. It is
  `null` in the module's whole page. `title`, one line of up to 80 characters, names the
  window after Hubble and the module's name as the sidebar shows it:
  "Hubble - Cyanview - Camera 3".
- Opening a view that already has a window brings that window to the front.
- Call it in answer to the operator's click or key press in the page. Hubble refuses a window
  the page asks for by itself, on a timer or as it loads, the way a browser refuses a pop-up.
- `page.canOpenWindows` is false where there are no windows to open, such as a plain browser,
  and `openWindow` rejects there. Leave the control out.
- In a window opened this way, `page.setWindowTitle(title)` changes its name, for example
  after the camera it shows was renamed. Hubble follows a rename of the module by itself.
- HubDash remembers its windows on that Mac and opens them again with the same `view` the
  next time it starts. A `view` must stay meaningful across restarts: use a stable ID, not a
  row number, and draw a plain "no longer here" state when it names something that is gone.
- The operator closes the window. A page cannot close or move a window, choose its size, or
  open anything but its own page.
- One HubDash keeps at most 16 module windows open, and `openWindow` rejects beyond that.

### List its parts in the sidebar

Right-click a module in the sidebar, and **Open in its own window ›** offers **Whole module**
and each part the page lists. Choosing a part opens the page in a window that shows only that
part, with `page.view` set to the part's `view`, titled "Hubble - TSL Tally - Routing". List the
parts on the section, beside `windows: true`:

```ts
{
  type: 'custom', id: 'app', label: 'TSL Tally', entry: 'ui/index.html', commands: [],
  windows: true,
  parts: [
    { view: 'tally', title: 'Tally' },
    { view: 'routing', title: 'Routing' },
    { view: 'setup', title: 'Setup' },
  ],
}
```

- For parts the operator adds, such as sheets, name a value the module publishes instead:
  `parts: { value: 'windowParts' }`, then `publishState` with
  `values.windowParts = [{ view, title }, …]`. Publish it again when a part is added, renamed or
  removed. A module that isn't running lists none.
- Draw only that part in its window: no tab strip and no other parts. Leave out what the page
  would save about where it is (the open tab, the selected sheet), so the module's whole page
  opens where it was.
- Use the same views the page passes to `openWindow`, so a part opened either way is one window.
- Up to 24 parts, each with its own `view`. A title is one line of up to 80 characters.
- A page Hubble draws, with no custom section, lists each of its sections by itself when it has
  more than one.

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
A page reaches another window only through `openWindow`, described above.
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

## Sliders in a bespoke layout

Use the host [slider](sliders.md) for a value an operator adjusts live. It runs in the
existing frame with no extra permissions. The module keeps validation, command queueing
and readback.

## Other shared controls in a bespoke layout

Use the host [controls](controls.md) for switches, segmented choices, steppers,
timecode, buttons, lamps, meters, an XY pad, standalone choice and colour pickers,
toasts and confirmations. They run in the existing frame with no extra permissions.
The module keeps validation, command queueing and readback.
