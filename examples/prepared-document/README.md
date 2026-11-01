# Prepared document workbook

Requires candidate Hubble 2.0.11 and the declared API 1 features. The package owns
its document schema, pure version migration and validation. Hubble renders the
same shared Matrix controls, applies edits immediately and saves accepted values.

`migrateDocument` upgrades version 1 to 2 before the replacement worker starts.
The read-only `prepare-list` query trims names on explicit edits and reports
invalid cells. Undo validates but preserves historical values exactly. Duplicate
rows start disabled through a declarative column policy. No device or network
services are used by this example.

Build, test and validate with the developer kit's `module-tool.mjs`. This example
alone is not evidence of installed UI or physical-device acceptance.
