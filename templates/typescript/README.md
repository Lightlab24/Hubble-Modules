# Module source

Edit `src/`, never generated `dist/`. `package.json` owns module identity and version.
Configuration descriptors, actions, feedback and lifecycle are separate files.
Keep protocol framing and transport in focused files when replacing this simulator.

Install the author dependencies, then run `npm run build`, `npm run typecheck`,
`npm test`, and `npm run validate`. The developer kit's CLI can also build and test
this example directly. Pack the built output with
`hubble-module pack . example-1.0.0.hubble-module`.

Build executes author source. Validate/pack/inspect read generated data only.
Import or download does not select a version or issue commands to hardware.
Preserve saved IDs and field meaning; `migrateConfig` migrates settings only.
