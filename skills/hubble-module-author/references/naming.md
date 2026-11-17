# Names, wording and where messages go

Operators move between modules all day, so the same thing should be called the same
thing everywhere. These rules cover labels a module declares and text it draws. A label
is presentation and an ID is the contract: change a label freely, never an ID.

## Connection settings

| Setting             | Label                  |
| ------------------- | ---------------------- |
| Address of a device | `Host or IP address`   |
| Its port            | `Port`                 |
| How long to wait    | `Request timeout (ms)` |
| Wait between tries  | `Reconnect delay (ms)` |

Use `IP address` only where a host name does not work. Qualify `Port` only when a module
has two different ports. Fields in a settings form or the Advanced editor use a capital
on the first word only.

## Button Matrix columns

Column headings take a capital on each main word, as Hubble's own do (`Button Text`,
`Text Color`). Use these names for the shared columns:

| Column                         | Heading          |
| ------------------------------ | ---------------- |
| Whether the row runs           | `Enabled`        |
| What the row does              | `Action`         |
| Whether the button shows state | `Feedback`       |
| The colours it shows           | `Feedback Color` |

Name a module's own columns after the thing they hold: `Camera Number`,
`Cyanview Controller`, `FS-HDR Target`.

## Action choices

Start with the verb and use a capital on the first word only: `Select camera`,
`Lock grid`, `Set HDR transform`. An empty required cell prompts with `Choose action`.
`No action` is a real choice that does nothing; do not use it as a prompt.

Before renaming a choice in an older module, search Hubble for the old text. Built-in
adapters still carry some choice labels for saved rows, for example Light Encode's
`Record / Stop All`. Renaming those in the module alone leaves saved buttons unmatched.

## Status words

For a device: `Online`, `Offline`, `Connecting` and `Not checked`. A value Hubble has
not confirmed is `Unknown`, never `Offline`. `Ready` is Hubble's word for a module that
is running; a module can be Ready while its device is Offline. A module that waits for
traffic says `Listening on` a port, or `Listening to` a broker or topic.

## Errors never move the page

An error must not push the page down or move a column. Show it in a place that is
always there and keeps its size:

- the status mark in the page's top corner,
- a bottom line of fixed height,
- the cell the error belongs to,
- Hubble's fading toast (`showToast`), or
- a list that floats over the page and opens only when asked for.

Do not insert a strip above a sheet, a line above a button, or a panel that narrows the
sheet. Counts, busy labels and field errors follow the same rule: keep a count visible
at zero, keep a button's label while it works, and reserve the line under a field.
Check it by measuring positions before and after each state, not by eye.

## A page a module draws itself

Keep the toolbar in this order, leaving out what the page does not have:

1. `Add <thing>`, then a count box named after the thing (`Cameras`, `FS-HDRs`).
2. `Refresh all`, `Send all` and `Pending sends`.
3. View options: layout, text size, expand and collapse, columns.
4. Details.

`Remove` takes something out of Hubble and leaves the device alone. `Delete` changes
the device. `Clear` empties values or hides something from view. Say which in the
confirmation.
