# Hubble and module ownership

Use this boundary when adding or moving an integration. It defines ownership, not
the completion status of an existing module.

| Hubble owns                                                                                                                                                    | The module owns                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shared Matrix/grid rendering and interaction: typing, selection, focus, dropdowns, colours, formulas, fill, clipboard, menus, rows, sheets and history routing | Its declared fields, labels, editors, choices, defaults, validation, computed values, formula/fill policies and layout composition |
| Generic settings/action/page rendering and scoped request delivery                                                                                             | Settings, actions, feedback, pages, controls, discovery providers and navigation declarations                                      |
| Shared slider rendering and interaction                                                                                                                        | Slider ranges and steps, validation, device commands and readback                                                                  |
| Shared control rendering and interaction: switches, segmented choices, steppers, timecode, buttons, lamps, meters, XY pad, pickers, toasts and confirmations   | Their values, choices, ranges, lamp states, meter zones, validation, device commands, readback and when to ask or notify           |
| Storage, transactions, ordered saves, undo, stable identities and import/export                                                                                | The meaning and schema of its data, and explicit versioned data migrations                                                         |
| Worker lifecycle, permissions, resource enforcement and cancellation transport                                                                                 | Device protocols, connection/reconnect behavior, subscriptions, command sequencing, calculations and completion evidence           |
| Feedback subscription routing and generic appearance rendering/arbitration                                                                                     | Active/inactive/unavailable decisions, feedback colours, glow conditions and integration workflows                                 |
| Signed native bridge and generic OS access primitives                                                                                                          | Target application identities, selectors, version profiles and application-specific workflows                                      |
| Package import, compatibility checks, version selection and rollback                                                                                           | Independently built module source, public dependencies, manifest and immutable release artifact                                    |

The host persisting a user-selected module colour does not make the colour's
meaning host-owned. The module determines what that feedback means; Hubble
stores the user's choice and renders it. Likewise, a generic discovery picker is
host-owned, but the module supplies and interprets its options.

Custom sidebar frontend code belongs in the package, including bespoke canvases
and designers. Hubble owns an isolated container and public scoped command/state
bridge, plus the actual shared Matrix surface that a custom page can compose
alongside its views. Helpers, templates, rendering and device implementations also
stay package-owned. Public dataset/document APIs must let the frontend, backend
and Matrix actions share the same portable data. See
[the extension model](extension-model.md) for required behavior and the explicit
gaps in current support; this ownership rule is not a claim those APIs already ship.

An external worker alone is incomplete extraction. Inspect every entry point:
connection setup/editing, Matrix, Advanced actions, pages, status, feedback,
execution, native operations and saved-data transfer. Module-specific host forms,
enums, compiler branches, feedback rules, protocol parsers and native application
profiles still prevent independent updates, even when protocol execution is in
a worker. Retain compatibility decoding only as necessary to preserve old data;
do not use it as the active implementation for a migrated package.

Keep device behavior in the package. Reusable public protocol libraries are
acceptable when their compiled code ships in that package. Importing private
Hubble implementation files or depending on host-bundled protocol code is not.
Hubble must consume supported declarations without a branch on the module ID.

Package addition, replacement and removal must register, update and remove its
screens through generic host navigation. Include that lifecycle in acceptance:
adding a compatible package must not require a new host sidebar branch; removing
it must not leave a broken screen. Follow the existing data-retention rules so
package removal does not silently discard saved workspace data.

## Which delivery changes?

Settings, actions, options, calculations, protocol fixes, feedback rules and page
composition using supported capabilities must ship as a module update. A new
reusable control, privileged OS operation or incompatible API contract requires
a host capability update first. Declare that minimum host version and required
feature explicitly. An SDK/kit version bump alone is not a host requirement.

Do not work around a missing API with a module-specific host screen, or move
shared Matrix implementation into a module. State the missing generic operation,
implement and document its public contract, then consume it from the module.

## Evidence of independent updates

Keep a per-module acceptance record with separate results for:

1. Public-only source build and package/descriptor validation.
2. Real shared-renderer settings, action editors, pages and applicable spreadsheet
   behavior, including delayed saves, further edits, failures and incoming feedback.
3. Non-default workspace/workbook transfer and old saved data; real-worker restart
   when persistence changes.
4. A package-only change to both a UI declaration and behavior on a compatible
   host, verifying the change after selection/reload. Compare full Hubble and
   HubDash file/link manifests before and after; version strings are insufficient.
   Include package add/remove navigation registration and restoration on re-add.
5. Native and physical-device checks, explicitly recording unavailable checks.
6. A previously unknown package's custom frontend, backend, shared-data/document
   use, host Matrix composition and supported helper lifecycle through addition,
   package-only UI/behavior update, removal and restoration. No host module-ID
   branch or private desktop message is permitted in that proof.

Record exact host, module and kit artifacts/digests. Do not mark a module complete
because another module passed, because its worker is external, or because the
shared renderer passes isolated tests. Carry the user's current restrictions
through testing and activation; this evidence requirement grants no permission
to interrupt an app or send commands to live devices.
