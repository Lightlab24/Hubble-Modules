import { matrix } from "./matrix.js";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";
import { ModuleDocumentValueSchema } from "@hubble/module-sdk";
import { listenerFields } from "./fields.js";
import {
  PAGE_COMMANDS,
  PAGE_ID,
  PAGE_SECTION_ID,
  PAGE_SETTINGS,
} from "./page.js";
import { defaultSwitcherDocument, SWITCHER_DOCUMENT_ID } from "./setup.js";
import { defaultRoutingDocument, ROUTING_DOCUMENT_ID } from "./routing.js";
import { PAGE_VIEWS } from "./views.js";

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: "2.3.0",
    requiredFeatures: [
      "module-matrix-v1",
      "module-feedback-observers-v1",
      "module-runtime-directory-v1",
      "host-services-v1",
      "host-service-registry-v1",
      "module-pages-v1",
      "module-page-icons-v1",
      "module-custom-pages-v1",
      "module-custom-pages-full-page-v1",
      // The page saves this module's own receiver settings.
      "module-frontend-settings-v1",
      // And it stays open while the listener restarts for them.
      "module-frontend-restart-v1",
      // The Routing tab: camera mappings in Hubble's own sheet controls.
      "module-spreadsheet-controls-v1",
      "module-spreadsheet-extended-editing-v1",
      "module-spreadsheet-layout-v1",
      // The page takes Hubble's Tally Switch place, which TALLY Switch held before the merge.
      "module-page-navigation-v1",
      "module-theme-v1",
      "module-controls-v1",
      // The Tally and Setup tabs sit on one line in the toolbar.
      "module-controls-inline-v1",
      "module-documents-v1",
      "module-fields-v2",
      "module-exchange-v1",
      "module-exchange-peers-v1",
      // The page is live in every HubDash window that shows it.
      "module-page-windows-v1",
    ],
  },
  configVersion: 1,
  // No "tally-receiver": it only made TALLY Switch tuck this page under its own page,
  // and this page now fills the app area with its own sidebar entry.
  capabilities: [
    "persistent-listener",
    "state-feedback",
    `service.page.${PAGE_ID}`,
    "host.documents",
  ],
  documents: [
    {
      id: SWITCHER_DOCUMENT_ID,
      label: "Ross switcher setup",
      version: 1,
      defaultValue: ModuleDocumentValueSchema.parse(defaultSwitcherDocument()),
    },
    {
      id: ROUTING_DOCUMENT_ID,
      label: "Camera routing",
      version: 1,
      defaultValue: ModuleDocumentValueSchema.parse(defaultRoutingDocument()),
    },
  ],
  settings: listenerFields,
  matrix,
  actions: [
    {
      id: "set-column-indication",
      label: "Set column indication",
      description: "Set indication on a column owned by this receiver.",
      completion: "local",
      timeoutMs: 5000,
      fields: [
        {
          id: "columnId",
          label: "Column ID",
          type: "text",
          required: true,
          default: "",
        },
        {
          id: "enabled",
          label: "Indication",
          type: "boolean",
          required: true,
          default: true,
        },
      ],
    },
    {
      id: "matrix",
      label: "Tally action",
      description: "Module-owned Tally feedback and follow controls.",
      completion: "local",
      timeoutMs: 5000,
      fields: [],
    },
    {
      id: "tsl.tally-feedback",
      label: "tsl.tally feedback",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.set-indication",
      label: "tsl.set indication",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.tally-switch",
      label: "tsl.tally switch",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: "tsl.follow",
      label: "tsl.follow",
      description:
        "Preserves the saved action contract and reports only observed completion.",
      completion: "local",
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [
    {
      id: "matrix",
      label: "Matrix tally",
      description: "Observed row colours, glow and address indication.",
      fields: [],
    },
    {
      id: "tally",
      label: "Program tally",
      description:
        "Observed tally for a configured feedback mapping; unavailable when stale or disconnected.",
      fields: [
        {
          id: "mappingId",
          label: "Camera mapping",
          type: "choice",
          required: true,
          default: "",
          choices: [],
          choiceProvider: "feedback-mappings",
        },
      ],
    },
  ],
  exchange: {
    data: [
      {
        id: "matrix-columns",
        label: "Owned Matrix columns",
        version: 1,
        query: true,
      },
      { id: "tally", label: "TSL tally observations", version: 1, query: true },
    ],
    // Routers, for routing on tally, and cross-receiver indication work with no approval step.
    // Routing used to be TALLY Switch's; it is this module's own now, so Follow needs no peer.
    peers: [
      { data: "router", version: 1, actions: ["route"] },
      {
        data: "matrix-columns",
        version: 1,
        actions: ["set-column-indication"],
      },
    ],
  },
  pages: [
    {
      id: PAGE_ID,
      label: "TSL Tally",
      icon: "ui/tsl.svg",
      layout: "full-page",
      // Hubble's own Tally Switch page stays hidden: routing on tally is on this page now.
      navigation: { replaces: "tally-switch" },
      sections: [
        {
          type: "custom",
          id: PAGE_SECTION_ID,
          label: "TSL Tally",
          entry: "ui/index.html",
          height: 560,
          commands: PAGE_COMMANDS.map((command) => ({ ...command })),
          settings: [...PAGE_SETTINGS],
          // Saving one of them restarts the listener. The page stays as it is meanwhile.
          restart: "keep-open",
          // Live in every HubDash window at once (e2e/windows.spec.ts): each copy saves only what it
          // changed, onto what is saved now, and follows what the others save. The open tab is each
          // window's own; the one last chosen is where the page opens next time.
          windows: true,
          // The sidebar's Open in its own window › offers each view as a part: its window shows
          // only that view, with no View control, and never changes where the whole page opens.
          parts: PAGE_VIEWS.map((part) => ({ ...part })),
        },
      ],
    },
  ],
});
