# Package-owned helpers

Candidate contract: API 1, `module-helpers-v1`, intended minimum Hubble 2.0.11.
Developer kit 1.5.0-dev.8 includes the client, Node helper runtime and public
`custom-canvas` example. Installed 2.0.10 does not provide this contract. Check
the selected host's capabilities before using it.

## Ownership and declaration

Keep native rendering libraries, USB/device logic, templates and application
workflows in the module project. Hubble verifies package files and manages process
lifecycle; it does not supply a printer implementation or silently install native
dependencies. Helpers are trusted package code, not an operating-system sandbox.

Require `module-helpers-v1` and `host-service-registry-v1`, declare `host.helpers`
in `capabilities`, and add a `helpers` declaration:

```ts
helpers: [
  {
    id: "renderer",
    label: "Renderer",
    variants: [
      {
        platform: "darwin",
        arch: "arm64",
        runtime: "node",
        nodeMajor: 22,
        entry: "helpers/renderer.mjs",
      },
    ],
    methods: [{ id: "render", readOnly: true, timeoutMs: 1000 }],
    readinessTimeoutMs: 5000,
    maxConcurrent: 2,
    memoryMb: 128,
  },
];
```

All entries must be declared package files under `helpers/`. A module can declare
up to eight helpers, one variant per platform/architecture, and 64 methods per
helper. Methods declare whether they are observational. A command method requires
an explicit backend `call` or `execute` operation; do not mark a device write
read-only to run it from a feedback callback.

The source host supports macOS/Linux `arm64`/`x64` process cleanup. A missing variant
returns `unavailable`. Windows variants can be described but this host returns
`unavailable` there. Node helpers require an ESM entry and an explicit matching
standalone Node major; the host reuses its service runtime. It does not search for
a system Node or run these helpers under Electron's ABI. Native helpers omit
`nodeMajor` and implement the same wire protocol. Module authors own supported
architectures, native ABI, dependent libraries and applicable OS signing needs.

## Build and run

The portable tool bundles Node helper sources independently of the module worker:

```json
{
  "hubble": {
    "helpers": { "helpers/renderer.mjs": "src/helper.ts" },
    "assets": ["helpers/renderer-data.bin"]
  }
}
```

Use declared static assets for prebuilt native executables, libraries and data.
No installation scripts run during package import. Load helper assets relative
to the helper entry; its working directory is temporary scratch storage.

```ts
// src/helper.ts: call only after module-owned initialization has finished.
import { serveModuleHelper } from "@hubble/module-sdk/helper-runtime";
serveModuleHelper({
  methods: {
    render: async (value, signal) => {
      signal.throwIfAborted();
      // Validate input, then call the module's renderer.
      return { text: String(value) };
    },
  },
  dispose: async () => {
    /* close module-owned resources */
  },
});
```

```ts
import { createModuleHelperClient } from "@hubble/module-sdk";
const renderer = createModuleHelperClient(context.services, "renderer");
const status = await renderer.start(); // startup or explicit call/execute only
if (status.status !== "helper" || status.state !== "ready")
  throw new Error(
    status.status === "helper"
      ? (status.message ?? "Unavailable")
      : "Unavailable",
  );
const result = await renderer.call("render", "Camera 1", operation.signal);
```

`start()` waits for readiness; repeated starts share the current instance.
`status()` reads its state without starting it. `stop()` requires an explicit
call/execute operation. Helpers belong to the owning package/worker generation,
not to a page. Closing a page cancels its pending calls; it does not tear down a
helper also used by Matrix actions. Cancelling a startup wait abandons that wait,
while the generation's helper can finish starting for other callers.

An update stops the previous generation before starting the replacement helper.
Removing/disabling the instance, stopping the worker or changing workspace also
stops its helpers. A crash or failed readiness is reported through status and
host diagnostics; calls do not automatically restart or replay. An explicit start
can retry the same immutable package. Selecting an older compatible package uses
its own helper bytes through the same lifecycle.

## Protocol and limits

The public schemas `ModuleHelperInputSchema` and `ModuleHelperOutputSchema`
define newline-delimited UTF-8 JSON on stdin/stdout. Stdout is reserved for that
protocol. Initialization emits `{"type":"ready","protocolVersion":1}`; calls
carry a UUID, method ID and JSON value. Replies are `result`, `error` or
`cancelled` for the same UUID. A cancellation acknowledgement means the handler
has settled, not merely that an abort was requested. Native helpers must exit on
stdin EOF and honor termination. Do not detach descendants from their process
group. The host drains stderr; use bounded, secret-free protocol errors and
module feedback for useful diagnostics.

Values are limited to 128K JSON characters. Each helper permits 1–16 concurrent
calls; the host permits 32 starting/ready helpers. Readiness deadlines are
100–30,000 ms and method deadlines 100–120,000 ms. `memoryMb` bounds Node's old-space
heap (64–1024 MiB), not total/native process memory. The transport limits buffered
input/output to 1 MiB and individual wire lines to 768 KiB.

Cancellation rejects the caller promptly and reserves capacity until the helper
acknowledges. If it does not settle within 500 ms, the host stops that helper and
reports that the operation's outcome may be unknown. A timeout, cancellation or
process exit cannot reverse a completed device command. Never replay an uncertain
command automatically. Shutdown sends TERM to the process group, then KILL after
500 ms if needed.

Compressed archives remain limited to 16 MiB and 128 files. Packages declaring
helpers can contain up to 32 MiB per `helpers/` file and 96 MiB of expanded archive
JSON (including base64 encoding). Other files retain their 8 MiB limit. Packages
without helpers retain the 32 MiB expanded limit. These are bounds, not a promise
that every combination fits; inspect the actual package. Frontend assets retain
their separate limits. Staged helper files are read-only, except that the selected
native executable is executable. The environment supplies only a basic system
PATH/LANG and `HUBBLE_HELPER_SCOPE`, `HUBBLE_HELPER_PACKAGE`,
`HUBBLE_HELPER_SCRATCH`; it does not inherit arbitrary service environment values.

Scratch is erased on normal cleanup and is never workspace data. Store portable
user content through [documents](documents.md), within its JSON limits. A large
portable binary-asset store is not provided by this contract. Package assets are
immutable dependencies, not a place to save user edits.

## Acceptance

Exercise readiness, concurrent calls, cancellation that settles and cancellation
that hangs, crashes, explicit restart, unsupported variants, changed package
bytes, update/rollback and instance/workspace removal. Verify old PIDs and scratch
directories disappear. The public example's frontend and Matrix action use the
same helper through the backend. Test a package-only change to its helper behavior
against unchanged host files. Offline worker/browser results do not establish
installed signing, native-library compatibility or physical-device acceptance.
