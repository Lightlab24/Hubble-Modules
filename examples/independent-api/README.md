# Independent API example

This SDK 1.2.0 candidate demonstrates conditional nested fields, multiple selections,
ordered arrays, draft-sensitive searchable/paginated choices, read-only host-service
discovery, and a pure saved-action migration. It changes local simulator state only.

From the extracted candidate kit, run `node module-tool.mjs build examples/independent-api`,
then `test`, `validate`, and `pack` using the same project path. No Hubble checkout,
running Hubble instance, network camera, or npm installation is needed.

The package uses API 1 with explicit required-feature negotiation. Its manifest uses
`savedActionVersion: 2`; selection from version 1 migrates literal `set-state` actions
and preserves formula sources, feedback, binding identities and order.
