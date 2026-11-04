# Full-page package frontend

Requires regular Hubble 2.0.18+ and `module-custom-pages-full-page-v1`.
The page declares `layout: "full-page"` and exactly one `custom` section. No
pixel height is needed. The package owns its header, tabs, scroll area and footer;
the host keeps its sidebar, sandbox and scoped backend bridge.

Use the kit's `module-tool.mjs build`, `test`, `validate` and `pack` commands on
this directory. The example makes local backend calls and opens no devices.
The `custom-canvas` example remains a fixed-height custom view beside the native
Matrix workbook; opt-in full-page pages cannot mix native sections.
