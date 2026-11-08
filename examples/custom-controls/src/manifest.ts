import { defineModuleManifest } from "@hubble/module-sdk/authoring";

const tally = {
  program: { tone: "red", label: "Program" },
  preview: { tone: "green", label: "Preview" },
  off: { tone: "off", label: "Off" },
} as const;
const audio = {
  type: "meter",
  min: -60,
  max: 0,
  unit: " dB",
  zones: [
    { from: -20, tone: "warning" },
    { from: -6, tone: "failure" },
  ],
} as const;

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.0.22",
    requiredFeatures: [
      "module-pages-v1",
      "module-custom-pages-v1",
      "module-workspace-instances-v1",
      "module-fields-v2",
      "module-controls-v1",
    ],
  },
  configVersion: 1,
  instanceScope: "workspace",
  capabilities: ["service.page.controls"],
  // Declared controls: Hubble draws and saves these. Each save restarts the instance.
  settings: [
    {
      id: "tallyOutput",
      label: "Tally output",
      type: "boolean",
      required: true,
      default: true,
      switch: {},
    },
    {
      id: "defaultBus",
      label: "Default bus",
      type: "choice",
      required: true,
      default: "pgm",
      segmented: {},
      choices: [
        { id: "pgm", label: "Program" },
        { id: "pvw", label: "Preview" },
        { id: "off", label: "Off" },
      ],
    },
    {
      id: "startPreset",
      label: "Start preset",
      type: "number",
      required: true,
      default: 1,
      min: 1,
      max: 99,
      integer: true,
      stepper: { step: 1 },
    },
    {
      id: "cueStart",
      label: "Cue start",
      type: "text",
      required: true,
      default: "01:00:00:00",
      timecode: { frameRate: "25" },
    },
  ],
  actions: [],
  feedback: [],
  pages: [
    {
      id: "settings",
      label: "Control settings",
      sections: [
        {
          type: "settings",
          id: "defaults",
          label: "Defaults",
          fields: ["tallyOutput", "defaultBus", "startPreset", "cueStart"],
        },
        {
          type: "status",
          id: "tally",
          label: "Tally and levels",
          fields: [
            {
              id: "cam1",
              label: "CAM 1",
              display: { type: "lamp", states: tally },
            },
            {
              id: "cam2",
              label: "CAM 2",
              display: { type: "lamp", states: tally },
            },
            {
              id: "cam3",
              label: "CAM 3",
              display: { type: "lamp", states: tally },
            },
            // Never published, so it shows as unknown rather than off.
            {
              id: "cam4",
              label: "CAM 4",
              display: { type: "lamp", states: tally },
            },
            { id: "audioL", label: "Audio L", display: audio },
            { id: "audioR", label: "Audio R", display: audio },
          ],
        },
      ],
    },
    {
      id: "controls",
      label: "Controls",
      sections: [
        {
          type: "custom",
          id: "app",
          label: "Controls",
          entry: "ui/index.html",
          height: 720,
          commands: [
            { id: "set", label: "Set a control" },
            { id: "press", label: "Press a button" },
            { id: "sources", label: "List sources" },
            { id: "clear-routes", label: "Clear routes" },
          ],
        },
      ],
    },
  ],
});
