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

The 1.2.0 candidate adds rich field descriptors, contextual paged choices, pure
saved-action migrations, and typed host-service clients. Require
`module-fields-v2`, `module-choices-v2`, `module-saved-actions-v1`, and
`host-service-registry-v1` for the contracts your module uses. The older
`host-services-v1` feature only promises the frozen requestHost aliases.
See `docs/independence-api.md` and `examples/independent-api` for the bounded
contracts and an inert example. These candidate artifacts are not published yet.
