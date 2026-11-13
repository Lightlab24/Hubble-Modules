# VENICE Camera Control

Hubble workspace module `venice-camera-control`. A full-page spreadsheet for Sony VENICE 2
cameras: one row per camera, 265 settings in 11 expandable groups (lens controls are
excluded), built on Hubble's shared spreadsheet controls. Camera names, addresses, logins,
staged values and the layout of every tab are saved in the scoped `camera-plan` document.

Requires Hubble 2.0.18 or later with the spreadsheet, custom page, document and alert host
features listed in `src/manifest.ts`.

## Build and test

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/modules.mjs build venice-camera-control
node scripts/modules.mjs test venice-camera-control
```

`pnpm --filter @hubble-module/venice-camera-control typecheck` checks types. The tests run
the real backend against fake cameras on loopback and never contact real equipment.

## Camera operations

Refresh and Send are explicit operator commands. Opening the page, editing, expanding
groups, resizing and changing columns send no device commands. Each connection uses fresh
HTTP Digest and WebSocket authentication. There is no captured-traffic replay and no
automatic write retry.

Before writing, the module refuses only a setting the camera reports as `Locked`. It sends
a fresh property request and waits for readback, which is the proof that a write took.
Writes stay staged on failure.

## Logins

Username and Password are sheet columns in the Login section of Columns, and drag-fill as a
copy. **They are saved in the workspace document, so they are plain text in workspace
exports and support logs.** There is no login dialog or Connect step. If a camera has no
login, Refresh selects its Username cell and says so. A camera that refused a login shows
Read failed and waits for a pressed Refresh, so a wrong password is never retried on its
own.

## Cameras, tabs and columns

The **Cameras** box sets how many rows the plan has, up to 24. Drag-fill continues an IP
series down Host / IP. Lowering the count asks first if a row being removed has been filled
in, and Undo restores it.

Each tab along the bottom is a saved view: which settings it shows, their sizes and order,
and whether cameras are rows or columns. Camera values are the same on every tab. Columns
can hide whole sections, paint a range of fields on or off in one drag, and clear every
optional column; right-clicking a column or setting row hides it. The toolbar's text size
control changes table text from 9 to 24.

## Refresh, offline cameras and Live

While the page is open, each camera with an address gets a 4-byte ping about every 3
seconds, with no login. A camera that stops answering shows Offline and blank, and can't be
edited. When it answers again it is read once and goes back to Ready. Nothing staged is
sent when a camera returns.

**Refresh all** reads every camera with an address and login at the same time, and only the
settings the open tab shows, including those inside collapsed sections. A setting that
newly appears on the tab is read straight away. A read never replaces a cell being typed
in or a value entered but not yet sent.

**Live** holds one connection open to each online camera and subscribes to its changes, so
they reach the sheet as they happen. It starts off each time the page opens and drops
within seconds of the page closing. A Live camera gets a keep-alive every 3 seconds instead
of the ping. If the keep-alive fails, one ping decides whether Live reconnects or the camera
shows Offline.

## Sending

The header switches between **Manual** and **Auto send**. The page always opens in Manual.
In Manual, editing stages a change, and Send or Send all writes it. In Auto send, a
committed edit (Enter, Tab, leaving a cell, a dropdown pick, a checkbox, paste or fill)
goes to that camera once its save has landed. Typing and Undo never send.

A changed cell carries an amber pending mark until the camera confirms the value.
**Pending sends** lists every staged change by camera, with what the camera last reported
and what will be sent. Cancel removes a staged change as one Undo step. Sends to one camera
run in order; different cameras run at the same time.

## Settings with special handling

- **Recording** is a read-only column beside Connection showing REC, STBY or Starting.
- **Shutter mode** is sent through `P.System.Menu.ShutterMode` (0 Speed, 1 Angle) and
  confirmed by the mode the camera then reports.
- **ND** reads and writes as density (Clear, 0.3 to 2.4).
- **Base ISO** offers the pair that matches the value the camera reports, 500 / 2500 or
  800 / 3200, because the camera reports no list.

## Alerts

With the page closed, the backend keeps pinging every 3 seconds. A camera that has
answered since Hubble started and then misses two passes in a row can raise a notification,
and its return raises one more. The Alerts panel chooses which, and all are off by default.

## Status

Camera ID, reel number, SDI 3/4 Info, Live, Recording and reads have been used on real
VENICE 2 cameras. Other settings have been tested against the loopback simulator only and
need checking on a camera with the matching sensor, licences, firmware and recording mode.
