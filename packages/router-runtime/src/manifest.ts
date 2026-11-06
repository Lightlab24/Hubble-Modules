import type { ModuleField, ModuleManifest } from "@hubble/module-sdk";
import type { ModuleManifestSource } from "@hubble/module-sdk/authoring";
import { routerMatrix, routerLabels, type RouterType } from "./matrix.js";
import { directRouteAction } from "./public-api.js";

export function routerSettings(type: RouterType): ModuleField[] {
  const automaticDimensions =
    type === "blackmagic-videohub" || type === "aja-kumo";
  const number = (
    id: string,
    label: string,
    value: number | null,
    min: number,
    max: number,
    description?: string,
  ): ModuleField => ({
    id,
    label,
    type: "number",
    default: value,
    required: value !== null,
    integer: true,
    min,
    max,
    ...(description ? { description } : {}),
  });
  return [
    {
      id: "host",
      label: "Host or IP address",
      type: "text",
      default: "",
      required: true,
      validation: {
        minLength: 1,
        maxLength: 253,
        message: "Enter the router hostname or IP address",
      },
    },
    number(
      "port",
      "Port",
      {
        "ross-ultrix-ogp": 5254,
        "evertz-quartz": 23,
        "blackmagic-videohub": 9990,
        "aja-kumo": 80,
      }[type],
      1,
      65535,
    ),
    number(
      "sourceLimit",
      "Sources to load",
      automaticDimensions ? null : type === "evertz-quartz" ? 32 : 152,
      1,
      type === "aja-kumo" ? 64 : 65536,
      automaticDimensions ? "Blank uses every detected input" : undefined,
    ),
    number(
      "destinationLimit",
      "Destinations to load",
      automaticDimensions ? null : type === "evertz-quartz" ? 32 : 152,
      1,
      type === "aja-kumo" ? 64 : 65536,
      automaticDimensions ? "Blank uses every detected output" : undefined,
    ),
    ...(type === "evertz-quartz"
      ? [
          {
            id: "levelSystem",
            label: "Quartz level system",
            type: "choice" as const,
            default: "16-level",
            required: true,
            choices: [
              { id: "8-level", label: "8 levels (V, A–G)" },
              { id: "16-level", label: "16 levels (V, A–O)" },
              { id: "magnum", label: "MAGNUM (V, A–U, W–Z)" },
            ],
          },
        ]
      : []),
    ...(!automaticDimensions
      ? [
          number(
            "levels",
            "Levels",
            type === "evertz-quartz" ? 1 : 17,
            1,
            type === "evertz-quartz" ? 26 : 256,
          ),
        ]
      : []),
    ...(type === "aja-kumo"
      ? [
          {
            id: "password",
            label: "Password",
            type: "text" as const,
            default: "",
            required: false,
            secret: true,
          },
        ]
      : []),
    number(
      "requestTimeoutMs",
      "Request timeout (ms)",
      {
        "ross-ultrix-ogp": 1000,
        "evertz-quartz": 2000,
        "blackmagic-videohub": 1000,
        "aja-kumo": 3000,
      }[type],
      100,
      10000,
    ),
    number(
      "reconnectDelayMs",
      "Reconnect delay (ms)",
      type === "ross-ultrix-ogp" || type === "blackmagic-videohub"
        ? 2000
        : 5000,
      100,
      60000,
    ),
    ...(type === "evertz-quartz"
      ? [
          number(
            "refreshIntervalSeconds",
            "Refresh interval (seconds)",
            60,
            0,
            3600,
            "0 disables the timer; otherwise use at least 10 seconds.",
          ),
        ]
      : []),
  ];
}

/** The four packages share implementation source, not a private host dependency. */
export function withRouterInterface(
  type: RouterType,
  base: ModuleManifestSource,
): ModuleManifestSource {
  return {
    ...base,
    lifecycle: { runWhenDisabled: true },
    host: {
      minimumVersion: "2.0.15",
      requiredFeatures: [
        ...new Set([
          ...("requiredFeatures" in base.host
            ? (base.host.requiredFeatures ?? [])
            : []),
          "host-service-registry-v1",
          "module-runtime-directory-v1",
          "module-contexts-v1",
          "module-documents-v1",
          "module-document-migrations-v1",
          "module-document-preparation-v1",
          "module-matrix-v1",
          "module-feedback-observers-v1",
          "module-matrix-context-v1",
          "module-matrix-row-fields-v1",
          "module-matrix-fill-rules-v1",
          "module-matrix-choice-presentation-v1",
          "module-matrix-field-presentation-v1",
          "module-matrix-quiet-incomplete-v1",
          "module-matrix-collections-v1",
          "module-choice-bindings-v1",
          "module-pages-v1",
          "module-custom-pages-v1",
          "module-settings-pages-v1",
          "module-page-navigation-v1",
          "module-disabled-state-v1",
          "module-optional-numbers-v1",
          "module-fields-v2",
          "module-choices-v2",
          "module-settings-v1",
          "module-exchange-v1",
          "module-presentation-v1",
        ]),
      ],
    },
    capabilities: [
      ...base.capabilities.filter((value) => value !== "host.router-groups"),
      "host.documents",
      "host.contexts",
      "service.editRoutingGroups",
      "service.page.routing",
      "service.page.routing-settings",
    ],
    matrix: routerMatrix(type),
    settings: routerSettings(type),
    documents: [
      {
        id: "router-view",
        label: "Router view preferences",
        version: 1,
        defaultValue: { zoom: 100 },
      },
      {
        id: "routing-groups",
        label: `${routerLabels[type]} groups`,
        version: 1,
        defaultValue: { contexts: [] },
        migrate: true,
        legacyImport: "router-groups",
        prepare: { id: "prepare-routing-groups", version: 1 },
      },
    ],
    pages: [
      {
        id: "routing",
        label: "Router",
        navigation: { replaces: "router" },
        sections: [
          {
            type: "custom",
            id: "router",
            label: routerLabels[type],
            entry: "ui/index.html",
            height: 920,
            commands: [
              "open",
              "close",
              "poll",
              "resources",
              "route",
              "interrogate",
              "result-page",
              "refresh",
              "settings",
              "set-zoom",
              "groups",
              "edit-group",
            ].map((id) => ({ id, label: id })),
          },
        ],
      },
      {
        id: "routing-settings",
        label: "Routing",
        placement: "module-settings",
        sections: [
          {
            type: "custom",
            id: "routing-settings",
            label: "Routing",
            entry: "ui/settings.html",
            height: 72,
            commands: ["groups", "edit-group"].map((id) => ({
              id,
              label: id,
            })),
          },
        ],
      },
    ],
    actions: [
      ...(base.actions.some(({ id }) => id === directRouteAction.id)
        ? []
        : [directRouteAction]),
      ...base.actions,
      {
        id: "matrix",
        label: "Routing action",
        description: "Run the configured Matrix routing action and group.",
        fields: [],
        legacy: true,
        completion: "submitted",
        timeoutMs: 120000,
      },
    ],
    feedback: [
      ...base.feedback,
      {
        id: "matrix",
        label: "Routing feedback",
        description:
          "Confirmed routes, manual stages, group enablement and selected destination colours.",
        fields: [],
      },
    ],
    exchange: {
      ...base.exchange,
      data: [
        ...(!base.exchange?.data.some(
          ({ id, version }) => id === "router" && version === 1,
        )
          ? [
              {
                id: "router",
                label: "Router readiness",
                version: 1,
                query: true,
              },
            ]
          : []),
        ...(base.exchange?.data ?? []),
        {
          id: "routing-groups",
          label: "Routing groups",
          version: 1,
          query: true,
        },
        {
          id: "prepare-routing-groups",
          label: "Validate routing group edits",
          version: 1,
          query: true,
        },
      ],
    } as ModuleManifest["exchange"],
  };
}
