# Sliders

Hubble supplies a shared slider. Require `module-sliders-v1` for either way of using
it, and check the actual host's `describe` feature list: an older build can report
the same version without the feature. Set `host.minimumVersion` to at least `"2.0.22"`.

| You want                                            | Use                                               |
| --------------------------------------------------- | ------------------------------------------------- |
| A numeric setting or page control                   | A `slider` option on the number field             |
| Live device control, or a slider in your own layout | `mountSlider` in a [custom page](custom-pages.md) |

Sliders are not available in table columns, native workbooks, or action and feedback
fields, because those edit as Matrix cells. A manifest that declares one there is rejected
rather than silently typed. Mount one with `layout: "cell"` when your own custom grid
needs a slider cell editor.

## Declare a slider field

```ts
{
  id: "zoom",
  label: "Zoom",
  type: "number",
  required: true,
  default: 100,
  min: 10,
  max: 200,
  slider: { step: 0.1, unit: "%" },
}
```

`min`, `max` and a numeric `default` are required. `max` and `default` must be whole
steps from `min`, because the thumb only stops on `min + n * step`. `step` is at least
`0.000001`, and `integer` fields need a whole-number `min` and `step`. `unit` is printed
directly after the value, so write `" dB"` to get a space.

The field works in settings, `controls` page sections, Matrix column settings and
nested `object` and `array` fields. Hubble shows the new value during the gesture and
calls the owning form once on release or key press, so a drag queues one save. The
stored value is the same plain number as any other number field, so adding `slider` to
an existing field needs no data migration. A saved number between stops stays valid
and is shown as it is; it snaps only when the operator moves the slider.

A slider on a setting saves like any other setting, so **each release restarts the
module instance** and any device connection it holds, unless the package declares
`settingsUpdate: "live"`. That suits configuration. For a value an operator adjusts
while a device is running, mount a slider and send a page command instead, which
restarts nothing. `controls` fields are transient inputs and also restart nothing.

## Mount a slider in a custom page

```ts
import { mountSlider } from "@hubble/module-sdk/slider-controls";

const slider = await mountSlider({
  root: element, // An empty element you own.
  label: "Zoom",
  layout: "inspector", // Or "cell" for a row-height editor.
  getState: () => ({
    value: local,
    min: 10,
    max: 200,
    step: 0.1,
    unit: "%",
    confirmedValue: fromDevice, // Optional: shown apart from the value.
    pending: queue.pending, // Optional.
    error, // Optional: validation or unconfirmed feedback.
  }),
  onValueChange(value) {
    local = value;
  },
  onValueCommit(value) {
    queue.push(value);
  },
});
```

`mountSlider` rejects outside a custom page, on a host without the feature, and when
the first state is invalid. Each element takes one slider. The runtime comes from the
host, so it adds nothing to your package and needs no extra frame permissions.

Call `slider.refresh()` after anything `getState` depends on changes, such as a
readback or a newly advertised range. Call `slider.dispose()` when removing it. A later
invalid state, or an exception from your callbacks, goes to `onError` and the control
keeps working from its last good state.

## Who owns what

The control owns presentation and interaction. It updates during the gesture without
waiting for you, ignores a readback while the pointer is down, and reports every step
to `onValueChange` followed by one `onValueCommit`. Each gesture commits once. A drag
that ends where it started commits nothing.

The module owns validation, serializing commands and readback:

- Apply the value in `onValueChange` straight away. `getState` is read back immediately
  after each callback, so a value you do not store snaps back.
- Queue the device command in `onValueCommit`. Keep one command in flight and collapse
  unsent values to the newest. `examples/custom-slider` has a tested queue to copy.
- Keep the device's value in `confirmedValue`, apart from the local value. An older
  readback must never overwrite a newer local edit.
- Read the device's value with `page.state()` before mounting, so a reopened page never
  shows a stale value first.
- When a command fails, keep the latest local value and set `error`.
- Keep the slider editable during background sync. Set `disabled` only for a real
  access, availability, dependency or firmware restriction.

## Test it

Run the page in the full renderer with a backend slow enough to hold a reply. These are
the cases that fail in practice:

- A second edit while a command is in flight. It shows at once, and the device ends on
  the newest value.
- A readback arriving during a drag. The thumb stays under the pointer.
- A rejected command. The value stays, the error shows, and the next edit clears it.
- Leaving the page and coming back. The first value shown is the device's.
- A slider on a setting. Each release starts a new worker generation, so check that the
  restart is acceptable and that no in-memory state is lost.

Reach the slider with Tab when checking the focus ring. Focus moved by script after a
pointer gesture does not show it, by browser design.

## Style it

Set tokens on the control or on any ancestor to share a palette. Colors can be hex, RGB,
HSL, CSS variables or `light-dark()` values.

| Token                                          | Controls                            | Default                           |
| ---------------------------------------------- | ----------------------------------- | --------------------------------- |
| `--slider-fill-color`                          | Filled track                        | Theme neutral                     |
| `--slider-thumb-color`                         | Thumb                               | Theme neutral                     |
| `--slider-track-color`                         | Empty track                         | Theme neutral                     |
| `--slider-focus-color`                         | Keyboard focus ring                 | Theme blue                        |
| `--slider-value-color`                         | Current value and confirmation      | Theme neutral                     |
| `--slider-error-color`                         | Validation and unconfirmed feedback | Theme red                         |
| `--slider-surface-color`                       | Control background                  | Transparent                       |
| `--slider-label-color`, `--slider-muted-color` | Label, secondary text               | Theme neutral                     |
| `--slider-track-size`                          | Track thickness                     | `4px`                             |
| `--slider-thumb-size`                          | Thumb diameter                      | `18px`                            |
| `--slider-hit-size`                            | Interactive height                  | `28px`, at least `44px` for touch |

```css
.my-zoom {
  --slider-fill-color: #8b5cf6;
  --slider-thumb-color: #fbbf24;
}
```

Pass `className: "my-zoom"` to add a class to the control itself, or
`theme: { fill: "#8b5cf6", thumb: "#fbbf24" }` for any subset of `fill`, `thumb`,
`track`, `focus`, `value` and `error`. `theme` beats CSS on the control.

Defaults follow Hubble's dark appearance. On a light page, set `color-scheme: light` on
the control. Do not style the control's internal class names; only these tokens and
`color-scheme` are API. Keep labels readable and keyboard focus visible. Keyboard
support is built in: arrows move one step, Page Up and Page Down move ten, and Home and
End go to the ends of the range.

A package can still bundle its own slider in a custom page. Use the same token names so
a later move to the shared control is a small change.
