# Controls

Hubble supplies shared controls for module settings, status sections and custom pages.
Require `module-controls-v1` for any of them, and check the actual host's `describe`
feature list: an older build can report the same version without the feature. Set
`host.minimumVersion` to at least `"2.0.22"`. Sliders have their own feature; see
[sliders](sliders.md). There is no rotary knob. Use a slider, a stepper or the
`rotate-left` and `rotate-right` gestures instead.

| You want                                | Declare                         | Mount in a [custom page](custom-pages.md) |
| --------------------------------------- | ------------------------------- | ----------------------------------------- |
| An On/Off switch                        | `switch` on a `boolean` field   | `mountSwitch`                             |
| 2 to 8 options as buttons               | `segmented` on a `choice` field | `mountSegmented`                          |
| − and + around a number                 | `stepper` on a `number` field   | `mountStepper`                            |
| HH:MM:SS:FF timecode                    | `timecode` on a `text` field    | `mountTimecode`                           |
| A tally lamp                            | `display: { type: "lamp" }`     | `mountLamp`                               |
| A level or progress bar                 | `display: { type: "meter" }`    | `mountMeter`                              |
| A trigger, momentary or latching button |                                 | `mountButton`                             |
| Pan and tilt, or any two axes           |                                 | `mountXYPad`                              |
| The Matrix choice editor outside a grid |                                 | `mountChoicePicker`                       |
| The Matrix colour editor outside a grid |                                 | `mountColorPicker`                        |
| A fading toast                          |                                 | `showToast`                               |
| A question before a destructive command |                                 | `confirm`                                 |

The switch is the module page's existing On/Off switch. Declared options work in
settings, `controls` page sections, Matrix column settings and nested `object` and
`array` fields. They are rejected in table columns, native workbooks and action and
feedback fields, because those edit as Matrix cells and keep their cell editors. A
boolean column keeps the Matrix checkbox.

## Declare a control

```ts
settings: [
  { id: "tallyOutput", label: "Tally output", type: "boolean", required: true,
    default: true, switch: { onLabel: "On", offLabel: "Off" } },
  { id: "bus", label: "Bus", type: "choice", required: true, default: "pgm",
    segmented: {},
    choices: [{ id: "pgm", label: "Program" }, { id: "pvw", label: "Preview" }] },
  { id: "preset", label: "Preset", type: "number", required: true, default: 1,
    min: 1, max: 99, integer: true, stepper: { step: 1 } },
  { id: "cue", label: "Cue", type: "text", required: true, default: "01:00:00:00",
    timecode: { frameRate: "25" } },
],
```

- `switch` labels are optional, at most 16 characters each.
- `segmented` needs 2 to 8 static choices and no `choiceProvider`.
- `stepper` needs `min`, `max` and a numeric `default` that is whole steps from `min`.
  A field cannot be both a slider and a stepper. `integer` also needs `module-fields-v2`.
- `timecode` rates are `23.976`, `24`, `25`, `29.97`, `29.97df`, `30`, `50`, `59.94`,
  `59.94df` and `60`. Drop-frame values use a semicolon, as in `01:00:00;00`, and skip
  the first frames of each minute except every tenth. An optional field may be empty.
  The same check is exported as `moduleTimecodeIssue` from `@hubble/module-sdk/timecode`.

The stored value is the field's plain type, so adding an option to an existing field
needs no data migration. Hubble shows each change at once and calls the owning form
once per flip, press or valid entry. A control on a setting saves like any other
setting, so **each change restarts the module instance** unless the package declares
`settingsUpdate: "live"`. For a value an operator changes while a device is running,
mount the control and send a page command instead.

## Declare lamps and meters

```ts
{
  type: "status", id: "tally", label: "Tally",
  fields: [
    { id: "cam1", label: "CAM 1", display: { type: "lamp", states: {
      program: { tone: "red", label: "Program" },
      preview: { tone: "green", label: "Preview" },
      off: { tone: "off" },
    } } },
    { id: "audioL", label: "Audio L", display: { type: "meter", min: -60, max: 0,
      unit: " dB", zones: [{ from: -20, tone: "warning" }, { from: -6, tone: "failure" }] } },
  ],
}
```

The field ID is the key in the instance's published `values`. A lamp maps 1 to 16
state keys to `red`, `green`, `amber`, `blue` or `off`; booleans and numbers match their
text, as in `"true"`. A missing, stale or unmapped value shows as **Unknown**, hatched
and dashed, never as off. Publish nothing for a disconnected device rather than `off`.
A meter needs `min` below `max`; up to 4 ascending zones start inside the range and
run to the next zone or `max`. A non-number shows as unknown.

## Mount a control in a custom page

```ts
import { mountSwitch } from "@hubble/module-sdk/controls";

const record = await mountSwitch({
  root: element, // An empty element you own.
  label: "Record",
  getState: () => ({
    checked: local,
    confirmedValue: fromDevice, // Optional: shown apart from the value.
    pending: queue.pending, // Optional.
    error, // Optional: validation or unconfirmed feedback.
  }),
  onCheckedChange(checked) {
    local = checked; // Apply it now, or it snaps back.
    queue.push(checked);
  },
});
```

Every mount takes `root`, `label`, `getState`, an optional `className` and an optional
`onError`, and returns `{ refresh(), dispose() }`. Input controls also accept
`confirmedValue`, `pending`, `error` and `disabled` in their state.

| Mount               | State                                                         | Callbacks                                      |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------- |
| `mountSwitch`       | `checked`, `onLabel?`, `offLabel?`                            | `onCheckedChange(checked)`                     |
| `mountSegmented`    | `value`, `options: [{ value, label }]` (2 to 8)               | `onValueChange(value)`                         |
| `mountStepper`      | `value`, `min`, `max`, `step`, `unit?`                        | `onValueChange(value)`                         |
| `mountTimecode`     | `value`, `frameRate`, `required?`                             | `onValueChange(value)`, only when valid        |
| `mountButton`       | `pressed?`, `confirmedPressed?`, `detail?`, `tone?`           | `onPress(pressed)`, `onRelease()`              |
| `mountLamp`         | `value` (key or `null`), `states`                             | none                                           |
| `mountMeter`        | `value` (or `null`), `min`, `max`, `unit?`, `peak?`, `zones?` | none; `orientation` in the options             |
| `mountXYPad`        | `value: { x, y }`, `x` and `y` ranges with labels, `unit?`    | `onValueChange(point)`, `onValueCommit(point)` |
| `mountChoicePicker` | `value`, `valueLabel?`; `choices` in the options              | `onValueChange(value)`                         |
| `mountColorPicker`  | `value` (`#RRGGBB`); `favorites` in the options               | `onValueChange(value)`                         |

- `mountButton` takes `mode`: `"trigger"` reports one `onPress(true)` on release inside
  the button; `"momentary"` reports `onPress(true)` on press and exactly one
  `onRelease()`, including when the pointer leaves or focus moves; `"latching"` reports
  `onPress(next)` with the new held state. `tone` is `neutral`, `program`, `preview`
  or `healthy`.
- `mountXYPad` holds the operator's point through readback during a drag and commits
  once per gesture. Arrow keys move and commit; Shift moves in finer steps. Up is the
  top of the y range.
- `mountChoicePicker` takes a list or a provider `(query, signal) => choices`, the same
  as a spreadsheet choice cell. Typing on the button opens it with that text. Keep the
  provider's identity stable during unrelated feedback.
- `mountColorPicker` saves favourites through `favorites: { get, set }` in module-owned
  preferences, or for the page's lifetime without it.
- `showToast({ kind?, title, message? })` shows Hubble's fading toast inside the page;
  hover or focus pauses it, and the newest four stay. `confirm({ title, message?,
confirmLabel?, cancelLabel?, danger? })` resolves `true` only from the confirm
  button. Cancel has focus first and Escape cancels. Confirmations queue one at a time.

A mount rejects outside a custom page, on a host without the feature, and when the first
state is invalid. Each element takes one control. A later invalid state, or an
exception from your callbacks, goes to `onError` and the control keeps its last good
state. `getState` is read again after every callback. The runtime comes from the host at
`/api/module-controls/controls-v1.js`, adds nothing to your package and needs no extra
frame permissions.

## Who owns what

Each control owns presentation and interaction. It shows a change at once without
waiting for you. The module owns validation, serializing commands and readback:

- Apply a change in its callback straight away and call nothing else first.
- Keep one command in flight per value and collapse unsent values to the newest.
  `examples/custom-controls` has a tested queue to copy.
- Keep the device's value in `confirmedValue`, apart from the local value. An older
  readback must never overwrite a newer local edit.
- Read the device with `page.state()` before mounting, so a reopened page never shows a
  stale value first.
- When a command fails, keep the latest local value and set `error`. Report a failure
  only for the newest value.
- Keep controls editable during background sync. Set `disabled` only for a real access,
  availability, dependency or firmware restriction.
- Ask with `confirm` before anything destructive, and send nothing on Cancel.

## Test it

Run the page in the full renderer with a backend slow enough to hold a reply. These are
the cases that fail in practice:

- Two flips, steps or choices while a command is held. Both show at once, and the device
  ends on the newest value.
- A readback arriving during an XY drag. The thumb stays under the pointer.
- A rejected command. The value stays, the error shows, and the next edit clears it.
- A momentary button released outside itself, by key, and on blur. Exactly one release.
- A lamp whose value is missing. It shows Unknown, not Off.
- Cancel on a confirmation. Nothing is sent.
- Leaving the page and coming back. The first value shown is the device's.
- A declared control on a setting. Each change starts a new worker generation, so check
  that the restart is acceptable.

## Style it

Set tokens on a control or any ancestor. Colors can be hex, RGB, HSL, CSS variables or
`light-dark()` values. Do not style internal class names; only these tokens and
`color-scheme` are API.

| Token                                                                                                                                | Controls                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `--control-label-color`, `--control-muted-color`, `--control-strong-color`                                                           | Text                                                  |
| `--control-surface-color`, `--control-hover-color`, `--control-selected-color`                                                       | Backgrounds                                           |
| `--control-line-color`, `--control-line-strong-color`                                                                                | Borders                                               |
| `--control-focus-color`                                                                                                              | Keyboard focus ring                                   |
| `--control-error-color`, `--control-pending-color`                                                                                   | Error and sending feedback                            |
| `--control-hit-size`                                                                                                                 | Interactive height, `28px`, at least `44px` for touch |
| `--switch-on-color`, `--switch-off-color`, `--switch-thumb-color`, `--switch-thumb-off-color`                                        | Switch                                                |
| `--segmented-selected-color`                                                                                                         | Selected segment                                      |
| `--button-width`, `--button-height`, `--button-program-color`, `--button-preview-color`, `--button-healthy-color`                    | Buttons                                               |
| `--lamp-red-color`, `--lamp-green-color`, `--lamp-amber-color`, `--lamp-blue-color`, `--lamp-off-color`                              | Lamps                                                 |
| `--meter-fill-color`, `--meter-warning-color`, `--meter-failure-color`, `--meter-track-color`, `--meter-thickness`, `--meter-length` | Meters                                                |
| `--xy-width`, `--xy-aspect`, `--xy-thumb-color`                                                                                      | XY pad                                                |
| `--picker-width`                                                                                                                     | Choice picker button                                  |

Defaults follow Hubble's dark appearance. On a light page, set `color-scheme: light` on
the control. Keyboard support is built in.
