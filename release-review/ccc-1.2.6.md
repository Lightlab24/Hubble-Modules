# CCC 1.2.6 local acceptance — 2026-11-01

The CCC controller previously queued host refresh requests behind selection saves.
Hubble's configuration reconciliation could then wait for a refresh while the
next selection waited for Hubble's save queue. The installed module repeatedly
hit its 120-second execution deadline and restarted.

Refresh now returns the current snapshot. Startup and the portable-document
watcher continue to load saved camera configuration. Selection feedback projects
pending local changes immediately, including a second selection before the first
save finishes. Receipts retain newer pending changes; save failures cancel
dependent selections and retain independent camera changes. Execution success
still follows durable persistence, and recording remains based on confirmed state.

- Package: `hubble-ccc` 1.2.6, API 1; unchanged feature requirements and document schema.
- Archive SHA-256: `026ce7872955b3b355d6f95a32fbc01dd868972aadd0b5d1cc9ca6e27cea753d`.
- 61 CCC protocol/module tests passed; TypeScript passed; package validation passed.
- Held-save tests cover immediate feedback, a second selection, reentrant host
  refresh, failed saves, dependent cancellation and unrelated-camera preservation.
- Installed on Hubble 2.0.15 without changing host bytes; 16 camera rows loaded,
  all available. The operator confirmed immediate Stream Deck selection feedback.
- Host main SHA-256 during that module-only acceptance:
  `dd73a43f506390c152c51138364eddb8738b6891238eea1eb724dc8523158bc2`.
- Host runtime-worker SHA-256:
  `0d828afe09e083d1707149557134a117ce85fe9802eebe3c3ec88dbf4339bd88`.
- HubDash app.asar SHA-256:
  `7428d4a323db113167bc1f666ec5a51361cf68859d814d659bd47def2662ceba`.

The host's direct CCC API had a separate admission-lock issue, corrected in the
companion host change. Isolated API tests with that fix completed four bursts of
eight selection commands without a worker restart or device commands. Local API
latency includes persistence; this is separate from immediate feedback and from
physical recording acceptance. No live recording command was issued for this fix.
