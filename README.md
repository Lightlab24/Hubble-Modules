# Hubble Modules

The public home for Hubble module downloads, developer tools, and community
submissions. Hubble's application source remains in its private repository;
application downloads remain in [Hubble-Releases](https://github.com/Lightlab24/Hubble-Releases).

The module platform is currently being tested in **Hubble2**. It requires the
Hubble 2 host/API 1 and does not add module loading to Hubble 1.5.1. No production
Hubble 2 application release is announced here. The initial catalog is empty;
device modules enter it only after maintainer qualification.

## Develop and test locally

Download the [developer kit](https://github.com/Lightlab24/Hubble-Modules/releases/tag/developer-kit-api1-preview.1),
extract it, and give `skills/hubble-module-author/SKILL.md` to your coding assistant.
The kit includes the SDK contracts, a simulator, an HTTP example, tests, packaging
tools, and a CLI that can import and reload a module while Hubble2 stays running.
Node.js 22 or newer is required; the kit does not need access to private source.

Edit a project under your Documents folder. Import its `.hubble-module` package
through **Module Connections → Module Library**, or link the project using the
kit's CLI. An explicit reload activates changed code. Building or editing files
does not silently replace a running module.

## Submit a module

Read [CONTRIBUTING.md](CONTRIBUTING.md). Submit a project under
`submissions/<module-id>/` with its manifest, implementation, and tests, or open a
module submission issue linking your source repository. Maintainers review
compatibility, observed completion/feedback, cleanup, reload, and saved action IDs.
Submission does not automatically publish a module or include it in an app release.

## Updates and versions

`catalog.json` is a signed version catalog. Hubble checks metadata in the
background and on request; it downloads only versions the user chooses. Applying
a version reloads affected module instances, while the service continues running.
Existing selections remain pinned to exact package identities. Previous versions
remain available for rollback unless explicitly withdrawn from new installations.

Approved packages use independent `module-<id>-v<version>` release tags. The
catalog identifies the exact archive digest, host/API compatibility, release
notes, and stable/beta channel. The application release and module release
histories are separate.

See [Publishing](docs/publishing.md) for the maintainer workflow. The public key is
in `keys/catalog.json`; signing credentials are never shipped in a package or kit.
