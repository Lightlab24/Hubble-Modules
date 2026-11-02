import { withRouterInterface } from "@hubble/router-runtime/manifest";
import { directRouteAction } from "@hubble/router-runtime/public-api";
import { defineModuleManifest } from "@hubble/module-sdk/authoring";

export default withRouterInterface(
  "ross-ultrix-ogp",
  defineModuleManifest({
    formatVersion: 1,
    apiVersion: 1,
    host: {
      minimumVersion: "2.0.0",
      requiredFeatures: [
        "host-services-v1",
        "module-exchange-v1",
        "module-fields-v2",
        "module-presentation-v1",
        "module-matrix-field-presentation-v1",
        "module-matrix-quiet-incomplete-v1",
      ],
    },
    configVersion: 1,
    capabilities: [
      "persistent-connection",
      "state-feedback",
      "host.router-groups",
      "service.refreshNames",
      "service.setDestinationLock",
      "service.recallSalvo",
      "service.routeCrosspoints",
      "service.interrogateRouteTargets",
      "service.selectDestination",
      "service.selectSource",
      "service.submitSelectSource",
      "service.take",
      "service.submitTake",
      "service.directRoute",
      "service.submitDirectRoute",
      "service.submitDirectRouteTracked",
      "service.watch",
      "service.unwatch",
    ],
    settings: [],
    exchange: {
      data: [
        { id: "router", label: "Router readiness", version: 1, query: true },
      ],
    },
    actions: [
      directRouteAction,
      {
        id: "ross-swp08.select-source",
        label: "select source",
        group: "Select Source",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
      {
        id: "ross-swp08.select-destination",
        label: "select destination",
        group: "Select Destination",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
      {
        id: "ross-swp08.take",
        label: "take",
        group: "Take",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
      {
        id: "ross-swp08.toggle-group-enabled",
        label: "toggle group enabled",
        group: "Group On/Off",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
      {
        id: "ross-swp08.direct-route",
        label: "direct route",
        group: "Route",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
      {
        id: "ross-swp08.refresh-names",
        label: "refresh names",
        group: "Refresh Names",
        description:
          "Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.",
        completion: "submitted",
        timeoutMs: 120000,
        fields: [],
        legacy: true,
      },
    ],
    feedback: [],
  }),
);
