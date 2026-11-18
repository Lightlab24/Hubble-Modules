# Hubble's look on a page a module draws

A page a module draws itself must look like part of Hubble, and must keep looking like it
when Hubble's look changes. Hubble hands every module page its colours, text sizes,
control sizes and corners by name. Use the names. Never copy a value out of Hubble, and
never write a second copy of Hubble's colour list into a module.

Hubble serves the stylesheet from `module-theme-v1` on. Link it before the page's own:

```html
<link rel="stylesheet" href="/api/module-controls/theme-v1.css" />
<link rel="stylesheet" href="./app.css" />
```

The page's frame may load it: it is served from the same place as the control bundles.

Give every name a fallback, `var(--hubble-sheet, #111)`, and the page still draws on a
Hubble that does not serve the stylesheet yet. A page written that way needs no entry in
`requires`. A page that cannot work without the names declares `module-theme-v1` there.

## The names

| Name                                             | Use it for                                        |
| ------------------------------------------------ | ------------------------------------------------- |
| `--hubble-sheet`                                 | The page and the sheet behind the rows            |
| `--hubble-bar`                                   | Header, toolbar and footer strips                 |
| `--hubble-raised`                                | Menus, floating lists, pills, raised panels       |
| `--hubble-hover`, `--hubble-selected`            | A row or button under the pointer, and the chosen |
| `--hubble-line-soft`, `--hubble-line`            | Lines between strips                              |
| `--hubble-line-strong`                           | A control's own border                            |
| `--hubble-sheet-header`, `--hubble-sheet-line`   | A sheet's heading row and grid lines              |
| `--hubble-text`, `--hubble-text-strong`          | Body text, and headings or values that must stand |
| `--hubble-text-secondary`                        | Labels and quiet text                             |
| `--hubble-text-disabled`                         | Text that cannot be used                          |
| `--hubble-focus`                                 | The keyboard focus outline                        |
| `--hubble-on`, `--hubble-ring`                   | A true mark, and the ring of a false one          |
| `--hubble-font`                                  | Every piece of text                               |
| `--hubble-text-size`, `--hubble-text-size-small` | Body text (13 px) and labels (12 px)              |
| `--hubble-control-text-size`                     | Text inside toolbar controls (11 px)              |
| `--hubble-control-height`                        | Toolbar buttons, filters, sheet tools (26 px)     |
| `--hubble-control-height-row`                    | Header actions and tabs (30 px)                   |
| `--hubble-control-height-field`                  | Settings boxes and the main button (34 px)        |
| `--hubble-radius-control`                        | Every control's corner                            |
| `--hubble-radius-surface`                        | Panels and dialogs                                |
| `--hubble-radius-menu-item`                      | A row inside a list or menu                       |
| `--hubble-shadow-floating`                       | Anything that floats over the page                |

`--hubble-sidebar` is Hubble's own sidebar colour. A module page sits beside it and has no
use for it, other than a strip that should match the sidebar exactly.

Status colours are not in this list. Keep a module's own red, amber and green.

## What the stylesheet does without being asked

- **Dropdowns.** Every `<select>` on the page opens Hubble's list, never the system's.
  Do not build a list of your own for a plain choice, and do not hide a `<select>` behind
  one. In a sheet cell, declare the column's `choices` and the shared sheet opens the same
  list.
- **Focus.** Buttons, boxes and anything with `tabindex` get Hubble's focus outline.

The rules for these have no weight of their own where they can, so a page's own rule for
the same thing still wins. Remove the page's rule if Hubble's is what you want.

## Checking it

Change a value in a local copy of the stylesheet and reload the page. Every surface that
should follow it follows it. A surface that stays is still using a copied value.
