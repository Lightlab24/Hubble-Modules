# Working with other modules

Use `context.modules` for shared data and public actions. Hubble routes requests, checks
identities and manages cancellation. What a module does with a peer belongs to the module.

## Declare the peers you need

Name each kind of peer in `exchange.peers`, and require `module-exchange-v1` and
`module-exchange-peers-v1`:

```ts
exchange: {
  data: [{ id: "following", label: "Following state", version: 1, query: true }],
  peers: [
    { data: "tally", version: 1, actions: [] },
    { data: "router", version: 1, actions: ["route"] },
  ],
},
```

Hubble then connects every running module in the workspace that shares that data, with
no operator step. Another package declaring `router` version 1 works without any change
here or in Hubble. Only the listed public actions are allowed, and only the declared data
is readable this way.

- `discover()` lists these peers. `bindings()` returns one for each, with a stable `id`
  and the module's current name. Offer those as choices, and save the `id`.
- Saved `id` references keep working across restarts and imports. Don't save a
  `connectionId` instead: import can map it to a different connection.
- A stopped peer disappears from both lists and returns with the same `id`. Hold when it's
  gone, and don't treat it as a configuration error.
- Connecting must never send a device command. Act only on a fresh operator or input event.
- A manifest with `exchange.peers` can't run on an older host, which reports the missing
  feature.

Don't write "approve" or "module permissions" into status text for a declared peer. There
is no such step, so the message leads nowhere.

## Peers you don't declare

Anything else stays denied by default. **Allow access to other modules' data** covers reads
from every module in the workspace. Actions on an undeclared peer need a saved approval, and
Hubble has no screen that grants one, so declare a peer you depend on.
