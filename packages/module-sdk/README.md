# Hubble module SDK

Public author contracts and reusable authoring/conformance helpers. This package
does not contain Hubble's runtime supervisor, catalog watcher, inventory or app UI.
Use `@hubble/module-sdk/authoring` for manifest composition and action registry;
use `@hubble/module-sdk/testing` with module-owned fake transports. SDK package
versions are independent of API 1 and independently released module versions.

See the developer kit guide and `skills/hubble-module-author` in Hubble-Modules.

Version 1.1.0 adds `ModulePageSchema`, `ModulePageTableSchema`,
`ModuleTableRowsSchema` and `validateModuleSettings`. See `docs/sidebar-pages.md`
and `examples/sidebar-page` in Hubble-Modules. Hosts advertise `module-pages-v1`;
API version remains 1.
