# Controls

Requires `module-controls-v1`. This example shows Hubble's shared controls against a
local stand-in for a device that replies after 400 ms. It opens no connections.

- **Declared:** the **Control settings** page has a switch, segmented choice, stepper
  and timecode field in its settings, and tally lamps and audio meters in its status
  section. Hubble draws and saves them. No frontend code is involved.
- **Mounted:** the **Controls** page mounts every control with
  `@hubble/module-sdk/controls`: switch, segmented, stepper, timecode, choice picker,
  colour picker, momentary, latching and trigger buttons, pan/tilt pad, lamp, meter,
  a confirmation before **Clear routes** and a toast after it.

Each live value keeps its local value apart from the device's and sends through
`src/latest-value-queue.ts`, which keeps one command in flight and collapses anything
that arrives meanwhile to the newest value. To see a rejected command, step the preset
to 13: the device refuses it, the stepper keeps 13 and shows the error, and the next
step clears it.

Use the kit's `module-tool.mjs build`, `test`, `validate` and `pack` commands on this
directory.
