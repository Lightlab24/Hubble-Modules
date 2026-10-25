# Hubble Modules

Official Hubble module source, reusable protocol packages, public author SDK and
reviewed downloads live here. All 14 initial official modules, including Evertz
Quartz, start at version **1.0.0**. Each module has its own version and release tag;
Hubble application releases remain in [Hubble-Releases](https://github.com/Lightlab24/Hubble-Releases).

The module platform is being qualified in isolated Hubble2. This repository does
not announce a production Hubble 2 app release or enable modules in Hubble 1.x.

## Build and develop

Use Node 22.22.2 and pnpm 11.0.8:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:modules
pnpm typecheck
pnpm test
pnpm test:protocols
pnpm package:modules
pnpm kit
```

`node scripts/modules.mjs package http-requests` qualifies one module independently.
Authors edit split TypeScript source, never generated `dist/module.mjs` bundles.
Protocol libraries and narrow host-service contracts are shared public packages;
no private Hubble checkout is required to build a module. The developer kit includes
its compiler, SDK types, multi-file starter, conformance helpers and author skill.
See [the developer guide](docs/developer-kit.md).

## Installation and versions

Import a `.hubble-module` archive through Module Library, or link a built project
using the kit's service client. Download/import does not activate it. Manual
selection reloads the chosen scope. Modules are stored by exact version and digest.

Automatic installation is off by default. Bindings may inherit the installation
setting or override it on/off; a pin wins. Opted-in compatible active stable
updates download in the background and apply only at the next service startup.
Beta versions remain a separate manual choice. Opening a page, changing workspaces
or importing a workspace does not trigger automatic application.

`catalog-v2.json` is signed discovery metadata, including requirements and channels.
`catalog.json` remains a compatible subset for older readers. Unknown future APIs
are visible but unavailable. Module requirements declare a full minimum app version
and needed host features; SDK/tool versions are independent. Existing API 1 modules
remain supported by compatible newer hosts. Previous archives and settings snapshots
support rollback subject to configuration compatibility.

## Contributions and publication

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [Publishing](docs/publishing.md).
PR checks and candidate builds have no publication credentials. Maintainers review
exact archive bytes before immutable release publication and catalog signing.
The app's curated offline bundle lock separately pins URL, size and digest; app
packaging downloads/caches those bytes instead of compiling module source.
