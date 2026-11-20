# Ping

Module ID `network-ping`, version 0.1.2. Pings network devices, keeps a timeline of each one, and
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

The toolbar sets what every device shares: **Pinging** (On or Paused), **Ping every** (0.2 s to
60 s) and **Size** (32 to 1400 bytes). The **Alerts** row under it sets the global **Answer over**
and **No answer for**, and whether an alert also raises a macOS **notification**.

Click a row to see its **timeline**. Pinch (or Ctrl and the wheel) zooms around the pointer, two
fingers or a drag move through time, and **Back to now** returns to the present. Bars are about two
pixels apart, one per ping where the history allows, and zooming in stops where one ping would be
wider than that. A bar with any lost ping is red from top to bottom.

## Alerts

A device goes **Offline** once it hasn't answered for its lost time and **Slow** as soon as an
answer is over its limit. It is Online again on the next answer, or after three answers in a row
under the limit. Each change:

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

`pnpm preview` serves the built page at http://127.0.0.1:43191 with the real backend and real
pings, in the same kind of sandboxed frame Hubble uses. `PING_RENDERER_ASSETS` points it at a
folder of Hubble's control bundles; it defaults to the installed Hubble. `/__inspect` shows the
saved document, log lines, alerts and feedback, and `/__simulate` holds, releases or fails saves.

`tools/flash-check.mjs` watches the timeline frame by frame across each Show last switch, against a
running preview, and reports any earlier picture that comes back.

## Not checked yet

Running inside HubDash or a real Hubble agent; a real notification, Status Log line or key; and
workspace export and import of `ping-plan`.
