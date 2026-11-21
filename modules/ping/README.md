# Ping

Module ID `network-ping`, version 0.1.8. Pings network devices, keeps a timeline of each one, and
alerts when a device stops answering or answers slowly. It is a workspace module: add it once, and
its **Ping** page lists every device. It needs a Hubble with `module-page-badges-v1` and
`module-controls-inline-v1` (2.3.1).

## The Ping page

One row per device, on Hubble's shared spreadsheet controls (selection, fill, copy and paste, undo,
checkboxes, menus, resize, row moves, zoom and the Columns list).

| Column | |
| --- | --- |
| Device | The name buttons use. Each device needs its own. |
| Enabled | Untick to stop pinging that device. |
| IP Address | An IPv4 address. Fills down as a series. |
| Alert Over | An answer time in ms. Empty follows the global setting; `off` never alerts. |
| Alert Lost For | A time in seconds without an answer. Empty follows the global setting; `off` never alerts. |
| Status | Online, Slow, Offline or Not checked. |
| Now, Average, Best, Worst, Jitter, Lost | Over the time chosen in Show last. Best and Jitter start hidden. |
| Last 10 Min | A small history strip; its heading follows Show last. |

**Add device** adds one row. The **Devices** box beside it sets how many rows there are: type a
number to add blank rows at the end or take the last ones off. Blank rows go without asking; a row
with anything filled in is named first, and Undo brings it back.

To remove several devices at once, select them and right-click: **Remove 3 devices**. Select by
dragging or Shift-clicking cells, or by the row numbers: click one, Shift-click for a range,
Command-click to add or drop one. Right-clicking outside the selection removes only that row. One
Undo brings them all back.

The toolbar sets what every device shares: **Pinging** (On or Paused), **Ping every** (0.2 s to
60 s) and **Size** (32 to 1400 bytes). The **Alerts** row under it sets the global **Answer over**
and **No answer for**, and whether an alert also raises a macOS **notification**.

**Sheets** sit just above the timeline, on Hubble's own sheet tabs, so different things can be
tracked apart: Cameras, Network, RIO. Each device is on one sheet, and every sheet's devices are
pinged and alert whichever sheet is open; the header counts them all. **+** asks for a name; a tab's
menu has Rename sheet…, Move sheet to end and Remove sheet, and tabs drag to reorder. Select rows to
get **Move selected rows…** on the tabs line. Add device and the Devices box work on the open sheet.
Removing a sheet removes its devices, naming any filled-in ones first; Undo brings them back.
Device names stay unique across sheets, because keys pick devices by name. A list from before
sheets opens as one sheet called Devices, and the open sheet is saved with the page.

Click a row to see its **timeline**. Pinch (or Ctrl and the wheel) zooms around the pointer, two
fingers or a drag move through time, and **Back to now** returns to the present. Bars are about two
pixels apart, one per ping where the history allows, and zooming in stops where one ping would be
wider than that. A bar with any lost ping is red from top to bottom. **Clear history** under the
timeline forgets every device's past pings after asking; devices and alert settings stay.

**Scale** sets the answer time at the top of the timeline, to any value from 0.1 ms to 10000 ms,
so a fast device stays readable when a few large pings come in. Drag the ms numbers on the left of
the timeline (the number you grab stays under the pointer), pinch over them, type a value in the
Scale box, or use its − and +. **Auto** fits the tallest bar on show; while it is on, the box shows
Auto's value, dimmed. A bar taller than the scale stops at the top with a white tip, and hovering
it still gives its real time. Double-clicking the ms numbers returns to Auto.

**Colors** under the timeline colours bars by answer time: type the time green goes up to, then
yellow, then orange; anything over the last time is red. Leave a time empty to skip that colour.
Each time has to be above the one before it. No answer stays red, as a full-height bar. The legend
lists the ranges, and the colours apply to the timeline and the strips in the sheet; keys keep
their Online, Slow and Offline colours. Until a time is typed, and after **Follow alert limit**,
bars are green under the Answer over alert and amber over it. The scale and the colour times are
each one setting for every device, saved with the page like Show last, and Undo covers them.

## Alerts

A device goes **Offline** once it hasn't answered for its lost time and **Slow** as soon as an
answer is over its limit. It is Online again on the next answer, or after three answers in a row
under the limit. The first state a device settles into raises no alert, so a restart or a newly
added device never announces one that was already down; every change after that does. Each change:

- writes a line to the Status Log, such as *RIO Truck B (10.192.4.31) stopped answering: no answer for 3 s*;
- raises a macOS notification when Notifications is on (no Dock bounce);
- changes any key that shows the device;
- counts in the badge on the Ping tab in the sidebar.

## Buttons

In the Button Matrix, add a Ping action column and pick a **Ping Device** on each row. The key
shows Online (green), Slow (amber) or Offline (red, blinking); the looks can be changed per row in
Feedback Color. Pressing a Ping key does nothing: it only shows status.

## How it pings

The worker runs the system's `fping` in loop mode (`-l -D -p <ms> -i 1 -b <bytes>`), one process
for every device, and reads one line per answer or timeout. `fping` must be installed; if it isn't,
the page says so on its bottom line and nothing is pinged. Nothing else is sent to a device.

History is kept in memory only and starts again when the module restarts: 0.2-second buckets for
15 minutes, one-second buckets for 2 hours and ten-second buckets for 24 hours. The device list,
settings and layout are saved in the workspace's `ping-plan` module document.

## Working on it

```sh
pnpm build
pnpm test
PING_PREVIEW_DEVICES="This Mac=127.0.0.1,Nobody=192.0.2.1" pnpm preview
```

`PING_PREVIEW_FAKE=1` answers with a stand-in for fping instead of real pings: about 0.8 ms with a
spike now and then, the last five minutes filled in at the start, and no answer from 192.0.2.x. It
sends nothing on the network.

`pnpm preview` serves the built page at http://127.0.0.1:43191 with the real backend and real
pings, in the same kind of sandboxed frame Hubble uses. `PING_RENDERER_ASSETS` points it at a
folder of Hubble's control bundles; it defaults to the installed Hubble. `/__inspect` shows the
saved document, log lines, alerts and feedback, and `/__simulate` holds, releases or fails saves.

`tools/sheets-check.mjs` drives the sheets with real input against a preview started with the six
devices it names, including a held and a failed save, Undo, and that the timeline never moves.

`tools/scale-check.mjs` drives the timeline's Scale and Colors with real input against a preview started with
`PING_PREVIEW_FAKE=1`, including a held and a failed save, and checks that nothing on the right of
the row under the timeline moves.

`tools/flash-check.mjs` watches the timeline frame by frame across each Show last switch, against a
running preview, and reports any earlier picture that comes back.

## Not checked yet

Running inside HubDash or a real Hubble agent; a real notification, Status Log line or key; and
workspace export and import of `ping-plan`.
