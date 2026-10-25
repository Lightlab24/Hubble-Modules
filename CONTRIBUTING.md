# Contributing a Hubble module

Start with the developer kit linked from the README. Test using Hubble2 and
simulators before using real equipment. Keep connection credentials, exported
workspaces, local logs, and private device information out of submissions.

Submit a pull request adding `submissions/<module-id>/` with:

- `hubble-module.json`, declaring a unique ID, independent version, host/API
  compatibility, settings, actions, gestures, feedback, and allowed package files.
- A bundled JavaScript implementation with no install-time scripts or native
  dependencies. Retain action/field IDs when updating an existing module.
- `module.test.mjs`, covering normal execution, failure, cancellation, disposal,
  reload, and migrations when settings change. Use protocol simulators; CI must
  not contact real devices or require credentials.
- `README.md` describing supported equipment, limitations, configuration, tested
  hardware/firmware, and what each success or failure actually confirms.
- An explicit license for your contribution and any bundled dependencies.

The authoring skill explains immediate action dispatch, feedback subscriptions,
button press/release semantics, unavailable state, structured logs, and the
difference between an accepted command and confirmed device state. Log steps
only when your implementation observes them.

Pull-request checks have no publication secrets. A maintainer reviews the exact
candidate archive before publication. Approval for the catalog and selection for
the app's bundled module set are separate decisions. Custom packages can be
imported locally without becoming official catalog entries.

If you maintain the source elsewhere, open a Module submission issue with a link
and a specific commit/tag. Do not attach credentials or compiled app bundles.
