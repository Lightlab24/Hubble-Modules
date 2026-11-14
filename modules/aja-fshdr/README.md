# AJA FS-HDR

Module ID `aja-fshdr`, version 2.0.0. Controls AJA FS-HDR frame synchronizers and HDR converters over their REST interface, from one page built on Hubble's shared spreadsheet controls. It needs Hubble 2.2.0 or later.

## The page

One **FS-HDR** page with tabs along the bottom.

| Tab | What it is |
| --- | --- |
| **Setup** | One row per FS-HDR: its name, address, connection, operating mode, an Allow sends tick and four input labels. The Units box sets how many rows there are, and addresses fill down as a series. Unit-wide settings such as genlock source and output frame rate can be added from Columns. |
| **Master** | Tick the channels you are editing. A change in the top Master row is staged on every ticked channel at once. A Master cell reads Mixed where the ticked channels differ. |
| Settings sheets | One row per channel, named by FS-HDR and input label. Each sheet keeps its own columns, chosen from Columns. Add as many as you like; a new sheet starts as a copy of the one that is open. A sheet can be turned so channels run across the top. |

A unit in HD/SD mode has four channels and a unit in 4K/UHD mode has one. The FS-HDR name is the unit's own System Name and the input labels are its Channel Names, so they show on the unit as well.

## Staging and sending

An edit is staged: the cell turns amber and nothing reaches a unit. **Send all** writes every staged setting to the units that are live, and **Pending sends** lists them with a Send and a Cancel for each row and each setting. With **Auto send** on, an edit is sent as it is committed; one Master edit sends to every ticked channel. Auto send is saved with the workspace and never sends anything by itself when the page opens.

Every write is checked against the unit's own limits, sent, and confirmed by reading the value back. A setting the unit refuses or does not confirm stays staged with the reason. Writes to one unit go one at a time; different units are written side by side. A unit whose Allow sends tick is off, or whose Remote Control setting is Local Only, is never written to.

The worker keeps one event connection to each unit whether or not the page is open, so cells follow changes made at the unit or by another controller. **Refresh all** drops those connections and reads every unit again from scratch. A unit that is not answering shows Offline with one blank, locked row.

A setting can be locked on a unit, with the reason as its tooltip: the unit reports it but does not let it be set, it belongs to the other operating mode, or its prerequisite is off (Custom Size needs Custom Size/Pos on). Settings that are stored once per frame-rate family or per transform are followed to the copy in use.

## Buttons

The Button Matrix action **Set HDR transform** takes a unit or All configured units, a processor and a transform. Its feedback is on when every chosen processor reports that transform, including changes made outside Hubble. **All FS-HDRs online** is on when every unit in Setup is live. Their IDs are unchanged from 1.x.

## Saved data

Everything is in one workspace document, `fshdr-plan`: the units, staged settings, tabs and their columns, the Master selection and the Auto send choice. It travels with workspace export and import. Units set up in 1.x are brought across once, the first time 2.0.0 starts with an empty plan, keeping whether each could be controlled. They are read straight away, and saved into the plan by the first page command or button press, because Hubble lets a module save its documents only during a command. Removing them later doesn't bring them back.

## Not covered

Presets, LUT file uploads, network settings, operating-mode changes, reboot and the audio matrix are not on the sheets. Use the unit's own page for those. The 1.x Parameters tab, which browsed every definition on a unit, is gone.

## Build and test

```sh
node scripts/modules.mjs build aja-fshdr
node scripts/modules.mjs test aja-fshdr
```

The tests use a small stand-in unit in `test/fake-unit.ts` and send nothing to real equipment.

`tools/preview.ts` runs the real page and the real worker code in a browser:

```sh
FSHDR_SIMULATOR_DIR=<FSHDR-Control-Hub checkout>/simulator node --import tsx tools/preview.ts
PLAYWRIGHT=<path to @playwright/test/index.mjs> node tools/qa-smoke.mjs
```

The first command starts three simulated units and serves the page on port 43971, using the shared controls from the installed Hubble. The second drives it with real clicks and typing and reads each result back from the simulators. [The simulator notes](../../docs/fs-hdr-simulator.md) say where the simulator lives. The preview is not the installed app.

`src/fields.json` lists the settings a sheet can show. `scripts/build-fields.mjs` regenerates it from a firmware capture; the bundled list is from firmware 4.3.2.5.
