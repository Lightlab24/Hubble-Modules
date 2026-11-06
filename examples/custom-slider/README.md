# Sliders

Requires `module-sliders-v1`. This example shows both ways to add Hubble's shared
slider, against a local stand-in for a device. It opens no connections.

- **Declared:** the `Trim` setting is a number field with a `slider` option. Hubble
  renders and saves it. No frontend code is involved.
- **Mounted:** the **Zoom** page mounts two sliders over one value with `mountSlider`,
  one in the `inspector` layout and one in the `cell` layout.

`src/latest-value-queue.ts` is the part a device module needs to copy. It keeps one
command in flight and collapses anything that arrives meanwhile to the newest value.
To see a failed command, narrow `ZOOM_RANGE` in `src/index.ts` and drag past it: the
slider keeps the value and shows the error, and the next edit clears it.

Use the kit's `module-tool.mjs build`, `test`, `validate` and `pack` commands on this
directory.
