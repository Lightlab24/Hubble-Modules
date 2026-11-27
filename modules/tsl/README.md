# TSL Tally

Official module `hubble-tsl`, version **1.6.1**, using stable Hubble module API **1**.
It receives TSL UMD 3.1 and 5.0 tally over UDP or TCP, shows what a switcher sends, routes a
router on tally (what TALLY Switch did, merged in at 1.4.0), feeds Button Matrix tally
feedback, and can set a Ross Carbonite switcher to send its tally to this computer.

## The page

`TSL Tally` fills the app area (`layout: "full-page"`) with three tabs. It takes Hubble's own
Tally Switch place in the sidebar (`navigation.replaces: "tally-switch"`), which TALLY Switch
held before the merge, so Hubble's older Tally Switch page stays hidden.

- **Tally** lists every address received, with its name and tally colours, as it changes.
- **Routing** is TALLY Switch, merged in: one row per camera (name, enabled, TSL address and
  screen, on-air lamp, router, output, source, level) with its live tally and routing
  status, and **Follow tally** in the toolbar. Each output follows the one camera on air.
  The rules are TALLY Switch's, carried over unchanged in `src/routing-engine.ts`: startup and
  a router coming back hold the route they find, only a fresh tally change routes, a route
  whose result was uncertain is never retried, two cameras on air or a missing router hold.
  Following on, chosen by the operator, catches up to the camera on air now. Cameras are the
  `routing` module document, saved with the workspace; Follow is kept on this computer
  (`routing-following.json`), never in the workspace, and starts off on a new computer.
  Routes go to router modules through module exchange (`exchange.peers`: `router` data,
  `route` action only), as TALLY Switch sent them. The sheet uses Hubble's spreadsheet
  controls: type, F2 or double-click to edit, Enter moves down, copy, paste, fill, Space for
  Enabled, the router list, Add camera and the row menu to add or delete. Edits show at once
  and save in order; a save the workspace refuses puts back only that edit. Command+Z and
  Shift+Command+Z (and HubDash's Edit menu) undo and redo edits and added or deleted cameras,
  one gesture at a time; a deleted camera comes back whole, in its place. Hubble keeps that
  history for the grid (`module-spreadsheet-history-v1`, from 1.6.0); on a Hubble without it
  the tab has no undo, as before. A step is what the tab took, as it shows it (from 1.6.1): a
  value it refused, a number Delete left alone or text that changed nothing is no step, so
  Redo of a Delete leaves numbers alone too. Undo selects what it put back and saves it like
  any other edit. There are no Undo or Redo buttons. Button Matrix "TALLY Switch follow"
  actions now drive this module's own Follow.
- **Setup** holds every setting of the link in one place:
  - **This computer** is the receiver. These are the module's own settings; the page saves
    them through Hubble (`settings` on the custom section, `module-frontend-settings-v1`),
    which restarts the listener. The page stays open meanwhile (`restart: "keep-open"`,
    `module-frontend-restart-v1`): it then reads everything again and redraws in place,
    leaving the box in use alone. A change made during the restart is saved next. The open
    tab and the last switcher reading are kept in the runtime directory, so they are still
    there after Hubble itself restarts.
  - **TSL devices on the switcher** lists the switcher's TSL UMD devices. Clicking one makes
    it the device the page edits: what its list line says shows at once, and the rest is read
    from its form. **New device** starts one the switcher doesn't have yet, named HUBBLE (or
    HUBBLE2 and on), sending what this computer listens for.
  - **Ross switcher** is that device, as the switcher has it, with the page's changes on top:
    TSL version, transport, port, Send to, name and options. A change not sent yet turns its
    label amber. The setup is saved in the `switcher` document, with the workspace, and
    reaches the switcher only on **Send to switcher**. `device` there is the name the device
    has on the switcher, so a new name is a rename of that device, not another device. A
    setup saved before 1.3.1 has no version, transport or port of its own: its device sends
    what this computer listens for, as it did then.
  - **Match switcher** sets this computer's TSL version, transport and port (and Listen on,
    when that is another address) to what the device sends, as last read from the switcher.
    It is offered only for a device that sends to this computer: one that sends elsewhere is
    pointed here first (Send to, then Send to switcher). Hubble can't take on an address this
    computer doesn't have, so when the address is all that differs the page says so, names this
    computer's address on the switcher's network, and gives both fixes: point the device here,
    or give this computer the address the device sends to. A save never runs beside a switcher
    request, because the restart would cut the request short.
  - Changing a device that sends somewhere else asks first. It may keep sending there; any
    other Send to must be one of this computer's addresses.

## Open in several windows

HubDash can show the page in several windows at once (`windows: true` on the section, which
requires `module-page-windows-v1`, so from 1.5.0 it loads only on a Hubble with module windows). Each
window is its own copy of the page over the one running module:

- A copy never saves its whole switcher setup or camera list. It sends only what it changed
  (`src/changes.ts`): the setup's changed fields, and the cameras deleted, added (after which
  camera) and the fields changed. The backend puts that onto a fresh read and, if another
  window saved in between, onto what that window saved, so a copy that is behind never undoes
  anything and no save is refused for being behind. A save of what is already saved writes
  nothing. Where two windows change the same field, the newer change stands.
- Changes the page makes by itself (the device's settings taken in after Read switcher, the
  device's name after Send to switcher) land only where the setup still holds what the page
  started from: another window's change to that field stays.
- Each window has its own Undo, for what was done in it (from 1.6.1, as Ping and Flanders).
  An Undo is saved like any other change, so every window shows it at once, but it puts a
  cell back only while the cell still holds what this window last put there, and takes a
  camera away only as this window last left it. What another window has changed since is
  left as it is, with "Camera 2's Source was changed in another window since, so it was left
  as it is". The page checks what it has read; the backend checks again with what the page
  last read (`expected` in the change, answered by `kept`), for a change another window saved
  a moment before. A Hubble whose grid undo checks cells itself, step by step, leaves such a
  cell before the page sees it and names it through `onHistoryLeft`, which the page answers in
  the same words; there, too, an older step stays off a cell this window typed over another
  window's value and then undid. With an earlier Hubble's grid undo that one case gets past the
  page's check. A camera added or deleted is the page's own step, so the page checks it.
- Every copy follows the others without a reload. Each `live` answer carries the saved setup's
  and the cameras' revisions, a stamp for the switcher's last reading and whether a switcher
  request is under way. A copy holding something older reads `saved` and redraws in place; its
  own changes on their way win, and the box or cell being typed in is never redrawn, moved or
  taken away. A camera deleted in another window while it is typed in stays under the typing
  and goes when it ends, with a note that it was deleted elsewhere. The backend also reads the
  setup (once a page has opened) and the cameras every 2 seconds for changes made outside it,
  such as an import.
- Receiver settings are saved by Hubble with only the values changed. Every copy hears of the
  restart (`onRestart`, and a new run in the next `live` answer) and reads everything again;
  a copy whose save was followed by another window's waits for the module to come back and
  shows the newest values. A settings save waits for another window's switcher request to end,
  since the restart would cut it short.
- Switcher requests from different windows wait their turn for the switcher's single Devices
  form, and each reads the setup when its turn comes.
- The open tab, Find and scroll are each window's own. The tab last chosen in any window is
  remembered on this computer, for where the page opens next time.
- One view in a window of its own: right-click TSL Tally in the sidebar, and **Open in its own
  window ›** offers **Whole module**, then **Tally**, **Routing** and **Setup** (`parts` on the
  section, from `src/views.ts`). That window, titled "Hubble - <sidebar name> - Routing", shows
  only that view with its own tools: no View control, and Setup, which has no tools, no
  toolbar. It never sends `view`, so the whole page still opens where it was left. A view the
  page does not have says "This part of the page is no longer here."

`e2e/windows.spec.ts` runs two and three copies of the built page against the preview and
checks all of the above with real clicks and key presses; `e2e/routing-undo-windows.spec.ts`
does the same for Undo. The preview opens a copy as one part's window at `/?view=tally`,
`/?view=routing` or `/?view=setup`.

## Talking to the switcher

`src/switcher/` speaks binary OGP (TCP 5253), the protocol DashBoard uses, to the switcher's
Ethernet Devices form. It is our own code, written from the protocol as observed on a
Carbonite Ultra 2ME (software 9.2.1); see the comments in `carbonite-devices.ts` for what was
seen on the real switcher. Adding, changing, turning on and off, cancelling and deleting this
module's own device ran there on Nov 19, 2026. Picking a device the module did not add, and
renaming one, have run only against the pretend switcher in `test/fixtures`.

- It writes only the fields of that form (`SWITCHER_WRITABLE_OIDS`), and only for the device
  the page edits, found by its name on the switcher. A rename may not take another device's
  name. Every other device must read back unchanged.
- It does nothing while someone has the form open in DashBoard.
- Every field is read back before Save; a mismatch cancels the edit.
- The page reaches the switcher only when the operator presses Read switcher, Send to
  switcher or Delete from switcher. Opening the page never does.

## Source ownership

- `src/module.ts` composes the instance: the receiver, Matrix feedback, the published tally
  data and the page. Hubble's own older TSL code still reads the reports the managed helper
  publishes, so the receiver stays wrapped in it.
- `src/receiver.ts` and `src/protocol.ts` are the TSL listener and packet parsing.
- `src/page.ts` is the page's backend; `src/frontend.ts` and `ui/` are the page. `src/setup.ts`
  holds the rules both share: the saved switcher setup and whether the two ends match.
- `src/matrix.ts` and `src/matrix-feedback.ts` own the Button Matrix column.
- `src/manifest.ts` declares actions, feedback, settings, the document and host features.

Existing saved IDs are preserved: settings, actions, feedback, `tally` and `matrix-columns`
data. Saved Button feedback mappings keep working; the page no longer edits them.

## Develop

Run the repository's `pnpm build` once, then `pnpm --filter @hubble-module/tsl build` and
`pnpm --filter @hubble-module/tsl test`.
`pnpm --filter @hubble-module/tsl preview` serves the built page on http://127.0.0.1:43197
against the real backend and a pretend switcher on this computer, with Hubble's shared
control files read from an installed Hubble. Each browser tab opened on it is another copy of
the page, as each HubDash window is, and each hears of a restart by itself. `/__simulate` holds
or fails saves, changes what is saved as an import would and makes the pretend switcher
misbehave; `/__inspect` shows what was saved, every write and conflict it received and the
commands the pages asked; `/__reset` puts everything back as it started.
`pnpm --filter @hubble-module/tsl test:ui` builds nothing: after a build it runs the `e2e`
specs in Playwright's Chromium against its own preview (port 43198, listener port 45728;
`TSL_UI_PORT` and `TSL_UI_LISTEN_PORT` move them). The undo specs need shared controls from a
Hubble with `module-spreadsheet-history-v1`: point `TSL_RENDERER_ASSETS` at such a build's
`renderer/main_window/assets` (or a folder of its `module-*-v1` files). With an earlier
Hubble's files they are skipped, and one check that the tab works without undo runs instead.
`pnpm --filter @hubble-module/tsl package` creates the versioned `.hubble-module` artifact.
