import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  instanceScope: "workspace",
  host: {
    minimumVersion: "2.0.11",
    requiredFeatures: [
      "module-workspace-instances-v1",
      "module-pages-v1",
      "module-custom-pages-v1",
      "module-table-workbook-v1",
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-documents-v1",
      "module-datasets-v1",
      "module-helpers-v1",
      "host-service-registry-v1",
    ],
  },
  capabilities: [
    "service.page.designer",
    "host.documents",
    "host.datasets",
    "host.helpers",
  ],
  helpers: [
    {
      id: "renderer",
      label: "Label renderer",
      maxConcurrent: 2,
      variants: (["darwin", "linux"] as const).flatMap((platform) =>
        (["arm64", "x64"] as const).map((arch) => ({
          platform,
          arch,
          runtime: "node" as const,
          nodeMajor: 22,
          entry: "helpers/renderer.mjs",
        })),
      ),
      methods: [{ id: "render", readOnly: true, timeoutMs: 1000 }],
    },
  ],
  documents: [
    {
      id: "design",
      label: "Label design",
      version: 1,
      defaultValue: {
        design: { title: "Camera 1" },
        labels: [
          { id: "label-a", values: { text: "Camera 1", copies: 1 } },
          { id: "label-b", values: { text: "Camera 2", copies: 2 } },
        ],
        labelsView: { version: 1 },
      },
    },
  ],
  settings: [],
  actions: [
    {
      id: "render",
      label: "Render label",
      description: "Uses the same local rendering function as the sidebar.",
      fields: [],
      completion: "local",
      timeoutMs: 1000,
    },
  ],
  feedback: [
    {
      id: "previewed",
      label: "Preview rendered",
      description: "A label has been rendered by this instance.",
      fields: [],
    },
  ],
  matrix: {
    id: "label",
    label: "Label renderer",
    actionId: "render",
    feedbackId: "previewed",
    primaryField: "module.text",
    fields: [
      {
        id: "module.text",
        label: "Text override (blank = saved design)",
        type: "text",
        default: "",
        formula: true,
        fill: "copy",
      },
    ],
  },
  pages: [
    {
      id: "designer",
      label: "Label designer",
      sections: [
        {
          type: "custom",
          id: "canvas",
          label: "Label canvas",
          entry: "ui/index.html",
          height: 430,
          commands: [
            { id: "render", label: "Render preview" },
            { id: "read", label: "Read design" },
            { id: "sources", label: "Browse shared data" },
            { id: "source-rows", label: "Browse source rows" },
            { id: "link-source", label: "Link source cell" },
            { id: "preview-linked", label: "Preview linked data" },
          ],
        },
        {
          type: "table",
          id: "labels",
          label: "Label data",
          source: "document",
          documentId: "design",
          dataset: { id: "labels", version: 1 },
          maxRows: 256,
          workbook: {
            stateKey: "labelsView",
            columns: {
              text: { formula: true, fill: "series" },
              copies: { formula: true },
            },
          },
          columns: [
            {
              id: "text",
              label: "Text",
              type: "text",
              required: true,
              default: "Camera 1",
            },
            {
              id: "copies",
              label: "Copies",
              type: "number",
              required: true,
              default: 1,
              min: 1,
              max: 99,
            },
          ],
        },
      ],
    },
  ],
});
