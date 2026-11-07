# TALLY Switch

An independent Hubble module that consumes TSL observations and invokes router actions through module API 1. Reception belongs to `hubble-tsl`; no sockets or router protocol implementation are duplicated here.

Add a TSL receiver and a router to the workspace. They connect automatically, with no permission step, because this package declares them in `exchange.peers`. Choose them for each camera mapping on the module page. Each output/level requires known tally from every enabled camera and exactly one on-air camera. For TSL 3.1, the default program indicator is flag 2; for 5.0 it is red text tally.

Startup and provider replacement establish a baseline without routing. An explicit Follow command can catch up to the current tally. Ambiguous, missing, stale or disconnected inputs hold the output. Routes are serialized per output and never retried after an uncertain result. Completion reports submission, without claiming hardware state confirmation.

Mappings retain stable row IDs and refer to peer binding IDs, which Hubble keeps resolving when an import maps those connections elsewhere. The local operator follow override lives in the module runtime directory; it is intentionally not exported, so importing a workspace cannot carry an operator's live override to another machine. The portable `enabled` setting supplies the initial state on a new machine. Live tally, routing status and socket generations are transient.

Existing Hubble follow buttons use a compatibility bridge. Once a TALLY Switch module exists in a workspace, the host's legacy routing engine is suspended, including while the module is disabled. Migration copies mapping order, flags, rows and routes before clearing the old sheet through normal configuration commands. A failed migration leaves routing paused.

Run `pnpm --filter @hubble-module/tally-switch package` to test and package the module. Tests use isolated workers and loopback traffic; no live switcher or router is controlled.
