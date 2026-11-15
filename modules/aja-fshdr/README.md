# AJA FS-HDR

Module ID `aja-fshdr`, version 2.1.3. Controls AJA FS-HDR frame synchronizers and HDR converters over their REST interface, from one page built on Hubble's shared spreadsheet controls. It needs Hubble 2.2.0 or later.

## The page

One **FS-HDR** page with tabs along the bottom.

| Tab | What it is |
| --- | --- |
| **Setup** | One row per FS-HDR: its name, address, a Simulated tick, connection, operating mode, an Allow sends tick and four input labels. The Units box sets how many rows there are, and addresses fill down as a series. Unit-wide settings such as genlock source and output frame rate can be added from Columns. |
| **Master** | Tick the channels you are editing. A change in the top Master row is staged on every ticked channel at once. A Master cell reads Mixed where the ticked channels differ. |
| Settings sheets | One row per channel, named by FS-HDR and input label. Each sheet keeps its own columns, chosen from Columns. Add as many as you like; a new sheet starts as a copy of the one that is open. A sheet can be turned so channels run across the top. |

A unit in HD/SD mode has four channels and a unit in 4K/UHD mode has one. The FS-HDR name is the unit's own System Name and the input labels are its Channel Names, so they show on the unit as well.

## Staging and sending

An edit is staged: the cell turns amber and nothing reaches a unit. **Send all** writes every staged setting to the units that are live, and **Pending sends** lists them with a Send and a Cancel for each row and each setting. With **Auto send** on, an edit is sent as it is committed; one Master edit sends to every ticked channel. Auto send is saved with the workspace and never sends anything by itself when the page opens. Sends go out a few at a time, a unit at a time in turn, because Hubble lets a page have only 32 requests waiting; Send all to 40 channels goes in one press.

Every write is checked against the unit's own limits, sent, and confirmed by reading the value back. A setting the unit refuses or does not confirm stays staged with the reason. Writes to one unit go one at a time; different units are written side by side. A unit whose Allow sends tick is off, or whose Remote Control setting is Local Only, is never written to.

The worker keeps one event connection to each unit whether or not the page is open, so cells follow changes made at the unit or by another controller. **Refresh all** drops those connections and reads every unit again from scratch.

## Presets before a unit is connected

A unit that isn't live (no address yet, Offline, Connecting or switched off) still has its sheet rows, one per channel of the operating mode chosen for it in Setup's **Mode** column. Its cells can be set: input labels in Setup and any setting on the sheets, with Master and the Framing sliders too. The choices and ranges come from the FS-HDR firmware 4.3.2.5 list built into the module, and a "—" means the unit's own value isn't known until it connects. A preset shows in amber like any staged change, and Pending sends lists it as "Sends after … connects". Send all only counts units that are live.

When the unit connects, its own mode replaces the planned one, presets it already matches drop away, and the rest stay amber until **Send** or **Send all** is pressed, even with Auto send on. Each is checked against the unit's own limits before it goes. Within one Send a setting that others depend on goes first, so Custom Size/Pos is on before Custom Size arrives, and a setting whose prerequisite is still off is tried again after the rest of its row. A preset for a channel the unit doesn't have in its mode stays listed so it can be cancelled.

## Simulated units

Ticking **Simulated** on a Setup row puts a simulated FS-HDR in its place: it runs inside Hubble from the same firmware 4.3.2.5 list and bench values, with no address and nothing on the network. Connection reads Simulated in blue, the Mode column chooses its operating mode (a change restarts it in that mode), and every tab, Master, Send, Auto send and slider work on it as on a real unit. What is written to it is saved in the workspace, so it keeps its settings over a restart.

Unticking Simulated keeps every setting written to the simulated unit as a preset for the real one, so a setup built on simulated units can be pointed at hardware and sent with Send all. The address in Host / IP is kept while a row is simulated.

Buttons never control a simulated unit: All configured units leaves it out, a button aimed at its address fails and says it is simulated, and it doesn't count towards All FS-HDRs online. A press during a show can't look confirmed by a unit that isn't there.

Framing settings the unit gives in percent (Custom Size, Custom H and V Pos, the four Custom crops and the four ROI edges) show as a slider with the number beside it. The range and step are the unit's own. **−** and **+** either side step it by the unit's own step (0.1 %); Shift steps ten, and held they keep going, faster the longer they are held. With Auto send on, a drag or a held − / + sends as it moves: one value at a time, the newest each time the unit answers, so the picture follows without a queue building up. On a Master row it goes to every ticked channel. Letting go then stages and sends the final value as usual. With Auto send off, a drag or a press stages one value, the same as typing it, and nothing reaches the unit until Send. Double-click the number, or select the cell and type, to enter an exact value. A Master cell that reads Mixed stays text until a value is typed.

A setting can be locked on a unit, with the reason as its tooltip: the unit reports it but does not let it be set, it belongs to the other operating mode, or its prerequisite is off (ROI edges need Region Of Interest on). Custom Size, Position and Crop stay editable while Custom Size/Pos is off: the unit's own page greys them out, but the unit takes them, so they can be set before it is switched on. Settings that are stored once per frame-rate family or per transform are followed to the copy in use.

## Buttons

The Button Matrix action **Set HDR transform** takes a unit or All configured units, a processor and a transform. Its feedback is on when every chosen processor reports that transform, including changes made outside Hubble. **All FS-HDRs online** is on when every real unit in Setup is live. Simulated units are left out of both. Their IDs are unchanged from 1.x.

## Saved data

Everything is in one workspace document, `fshdr-plan`: the units, staged settings, tabs and their columns, the Master selection and the Auto send choice. It travels with workspace export and import. Units set up in 1.x are brought across once, the first time 2.0 starts with an empty plan, keeping whether each could be controlled. They are read straight away, and saved into the plan by the first page command or button press, because Hubble lets a module save its documents only during a command. Removing them later doesn't bring them back.

A second document, `fshdr-sim`, holds what has been written to each simulated unit, by the unit's own setting IDs. It is saved by the page command that sends to a simulated unit, and the entry goes when the row stops being simulated. Planned modes and presets are in `fshdr-plan` with everything else staged.

## Not covered

The unit's own preset memories, LUT file uploads, network settings, operating-mode changes, reboot and the audio matrix are not on the sheets. Use the unit's own page for those. The 1.x Parameters tab, which browsed every definition on a unit, is gone.

## Build and test

```sh
node scripts/modules.mjs build aja-fshdr
node scripts/modules.mjs test aja-fshdr
```

The tests use a small stand-in unit in `test/fake-unit.ts` and send nothing to real equipment.

`tools/preview.ts` runs the real page and the real worker code in a browser:

```sh
FSHDR_SIMULATOR_DIR=<FSHDR-Control-Hub checkout>/simulator FSHDR_SIMULATORS=four,four,single,four PREVIEW_UNITS=3 node --import tsx tools/preview.ts
PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<path to a Chromium> node tools/qa-smoke.mjs
```

The first command starts four simulator processes, puts the first three in Setup and serves the page on port 43971; the fourth stands in for a unit that is connected later. It uses the shared controls from the installed Hubble. The second drives it with real clicks and typing and reads each result back from the simulators. [The simulator notes](../../docs/fs-hdr-simulator.md) say where the simulator lives. The preview is not the installed app.

`tools/qa-live.mjs` checks Send all to 40 channels, sending while dragging and the − and + buttons, against ten simulators. Its header has the commands. The preview refuses a page's 33rd waiting request, as Hubble does.

`src/fields.json` lists the settings a sheet can show, and `src/catalog.json` holds what the worker needs for presets and simulated units: those settings' descriptors, the settings they map onto or depend on, and the bench values. `scripts/build-fields.mjs` regenerates both from a firmware capture; the bundled list is from firmware 4.3.2.5. Playwright's own Chromium works for the browser checks; Google Chrome 157 drops some of Playwright's clicks into the sandboxed page.
