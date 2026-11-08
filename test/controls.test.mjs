import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MODULE_CONTROLS_FEATURE,
  mountSwitch,
} from "../packages/module-sdk/dist/controls.js";
import {
  ModuleManifestSchema,
  moduleTimecodeIssue,
} from "../packages/module-sdk/dist/index.js";

const fields = [
  {
    id: "recording",
    label: "Recording",
    type: "boolean",
    required: true,
    default: false,
    switch: { onLabel: "Rec", offLabel: "Stop" },
  },
  {
    id: "bus",
    label: "Bus",
    type: "choice",
    required: true,
    default: "pgm",
    segmented: {},
    choices: [
      { id: "pgm", label: "Program" },
      { id: "pvw", label: "Preview" },
    ],
  },
  {
    id: "preset",
    label: "Preset",
    type: "number",
    required: true,
    default: 1,
    min: 1,
    max: 99,
    stepper: { step: 1 },
  },
  {
    id: "cue",
    label: "Cue",
    type: "text",
    required: true,
    default: "01:00:00:00",
    timecode: { frameRate: "25" },
  },
];
const manifest = (overrides) => ({
  formatVersion: 1,
  id: "example-controls",
  name: "Controls",
  version: "1.0.0",
  apiVersion: 1,
  host: { minimumVersion: "2.0.22", requiredFeatures: ["module-controls-v1"] },
  configVersion: 1,
  entry: "module.mjs",
  files: ["module.mjs"],
  capabilities: [],
  actions: [],
  feedback: [],
  settings: fields,
  ...overrides,
});

test("control field options and status displays require the host feature", () => {
  assert.equal(MODULE_CONTROLS_FEATURE, "module-controls-v1");
  const parsed = ModuleManifestSchema.parse(manifest({}));
  assert.deepEqual(
    parsed.settings.map((field) =>
      Object.keys(field).find((key) =>
        ["switch", "segmented", "stepper", "timecode"].includes(key),
      ),
    ),
    ["switch", "segmented", "stepper", "timecode"],
  );
  for (const field of fields)
    assert.throws(
      () =>
        ModuleManifestSchema.parse(
          manifest({
            host: { minimumVersion: "2.0.22", requiredFeatures: [] },
            settings: [field],
          }),
        ),
      /module-controls-v1/,
    );
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({
          settings: [],
          host: {
            minimumVersion: "2.0.22",
            requiredFeatures: ["module-pages-v1"],
          },
          pages: [
            {
              id: "tally",
              label: "Tally",
              sections: [
                {
                  type: "status",
                  id: "lamps",
                  label: "Lamps",
                  fields: [
                    {
                      id: "cam1",
                      label: "CAM 1",
                      display: {
                        type: "lamp",
                        states: { on: { tone: "red" } },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    /module-controls-v1/,
  );
});

test("control field options are rejected where they would only edit as Matrix cells", () => {
  const definition = { id: "rec", label: "Rec", description: "Rec", fields };
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({
          actions: [{ ...definition, completion: "response", timeoutMs: 1000 }],
        }),
      ),
    /not available in action or feedback fields/,
  );
  assert.throws(
    () =>
      ModuleManifestSchema.parse(
        manifest({
          settings: [],
          host: {
            minimumVersion: "2.0.22",
            requiredFeatures: ["module-controls-v1", "module-pages-v1"],
          },
          pages: [
            {
              id: "rows",
              label: "Rows",
              sections: [
                {
                  type: "table",
                  id: "rows",
                  label: "Rows",
                  source: "settings",
                  maxRows: 2,
                  columns: [fields[0]],
                },
              ],
            },
          ],
        }),
      ),
    /not available in table columns/,
  );
});

test("timecode is checked against its frame rate", () => {
  assert.equal(moduleTimecodeIssue("01:00:00;00", "29.97df"), null);
  assert.match(moduleTimecodeIssue("00:00:10:25", "25"), /frames go up to 24/);
});

test("mounting outside a Hubble custom page rejects instead of drawing nothing", async () => {
  globalThis.window = globalThis;
  globalThis.location = new URL("https://example.test/elsewhere");
  try {
    await assert.rejects(
      mountSwitch({
        root: {},
        label: "Record",
        getState: () => ({ checked: false }),
        onCheckedChange() {},
      }),
      /require a Hubble custom page/,
    );
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("the public skill says there is no rotary knob", async () => {
  const reference = await readFile(
    new URL(
      "../skills/hubble-module-author/references/controls.md",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(reference, /no rotary knob/i);
  for (const name of [
    "mountSwitch",
    "mountSegmented",
    "mountStepper",
    "mountTimecode",
    "mountButton",
    "mountLamp",
    "mountMeter",
    "mountXYPad",
    "mountChoicePicker",
    "mountColorPicker",
    "showToast",
    "confirm",
  ])
    assert.match(reference, new RegExp(`\\b${name}\\b`), name);
});
