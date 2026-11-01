# MQTT Capture

MQTT Capture 1.0.0 is an independently packaged sidebar utility for investigating MQTT traffic, including
CCC gain controls. It has no workbook actions or feedback assignments. It requires
a Hubble host that advertises `module-page-controls-v1`, `module-pages-v1`, and
`module-runtime-directory-v1` (minimum Hubble 2.0.6; check the host feature list).

Open **MQTT Capture** in the sidebar, enter the broker's IPv4 or IPv6 address,
leave port **1883** unless the broker uses another port, and click **Start new
capture**. The module subscribes to `#` and `$SYS/#` using an anonymous, clean
MQTT 3.1.1 session. It never publishes device commands. Authentication and TLS
are not supported by this version.

The live view shows connection state, endpoint, total messages, unique topics,
retained and live counts, captured size, start and last-message times, and the
latest 100 messages. Long payloads are shortened only in the preview. Enter a
note and click **Add marker** to record when you pressed Gain Up/Down or saw a
failure. Capture continues when you navigate away from its page.

Click **Stop**, then **Copy transcript** to paste the evidence into a chat, or
**Export transcript** for a text file. Clipboard transfer is limited to 2 MB;
export preserves larger captures. The transcript is JSON Lines with UTC receipt
times, topics, exact text payloads (base64 for invalid UTF-8), retained, QoS and
duplicate flags, connection events, markers, and stop reasons. Retained values
are snapshots, not new commands. MQTT does not reveal the original publisher's
identity to a subscriber, or traffic that the broker refuses to deliver.

A capture stops explicitly on disconnection, protocol error, or its limits:
16 MiB / 100,000 messages per capture and 1 MiB per MQTT packet. It does not
silently reconnect or truncate an oversized message. Limits and errors are
recorded in the transcript. Start again to capture another session.

## Local data and workspace transfer

This utility adds no saved workspace fields. Its settings and actions arrays are
empty; control inputs are transient. Each capture is saved in this module
instance's Hubble runtime directory. Captures deliberately stay local and are
excluded from workspace export/import because diagnostic traffic can contain
private device data and is evidence rather than reusable workspace configuration.
Use Copy/Export to transfer it explicitly. The most recent capture is restored
stopped after restarting Hubble; it never reconnects on startup. Previous capture
files remain in the runtime directory. Closing the workspace or disabling the
module stops an active capture.

## Build and verify

Keep authored source in this public modules repository. From its root:

```sh
pnpm exec tsc --noEmit -p modules/mqtt-capture/tsconfig.json
node packages/module-tools/dist/module-tool.mjs build modules/mqtt-capture
node packages/module-tools/dist/module-tool.mjs test modules/mqtt-capture
node packages/module-tools/dist/module-tool.mjs validate modules/mqtt-capture
node packages/module-tools/dist/module-tool.mjs pack modules/mqtt-capture mqtt-capture-1.0.0.hubble-module
node packages/module-tools/dist/module-tool.mjs inspect mqtt-capture-1.0.0.hubble-module
```

The tests use loopback TCP brokers only. Installing the package does not start a
network capture. Opening its page and pressing Start is the operator action.

## Source provenance

This source was originally authored in chat `01a1866e-e920-7241-9dc7-d5f2d4d1ad47`
in a temporary modules checkout. On 31 October 2026 it was restored into
`Hubble-Modules/modules/mqtt-capture` from the recorded source edits. The rebuilt
manifest and every runtime file match the selected 1.0.0 archive exactly
(SHA-256 `6f9b8fe8afe74ddb3e225e9a1640f511cbc8333aa4ab38bf40f518a5c4a90695`).
No existing release archive was overwritten. Authoring instructions and tests now
use the maintained public repository toolchain; the runtime remains unchanged.

Hubble owns the shared read-only grid, clipboard/download controls and scoped
worker/storage APIs. This package owns MQTT parsing, capture lifecycle, limits,
transcript contents, status and page declarations. Capture data stays local; only
module selection and ordinary portable host layout state belong in workspace transfer.
