import { expect, it } from "vitest";
import { ModuleManifestSchema, moduleCompatibility } from "@hubble/module-sdk";
import aja from "../../../modules/aja-kumo/src/manifest.js";
import blackmagic from "../../../modules/blackmagic-videohub/src/manifest.js";
import evertz from "../../../modules/evertz-quartz/src/manifest.js";
import ross from "../../../modules/ross-ultrix-ogp/src/manifest.js";

it.each([
  ["aja-kumo", aja],
  ["blackmagic-videohub", blackmagic],
  ["evertz-quartz", evertz],
  ["ross-ultrix-ogp", ross],
] as const)(
  "%s requires the host capabilities used by its shared presentation",
  (type, source) => {
    const manifest = ModuleManifestSchema.parse({
      ...source,
      id: `hubble-${type}`,
      name: type,
      version: "1.1.3",
      entry: "module.mjs",
      files: [
        "module.mjs",
        "ui/index.html",
        "ui/settings.html",
        "ui/app.js",
        "ui/logo.svg",
      ],
    });
    const features =
      "minimumVersion" in manifest.host
        ? (manifest.host.requiredFeatures ?? [])
        : [];
    expect(features).toEqual(
      expect.arrayContaining([
        "module-matrix-field-presentation-v1",
        "module-matrix-quiet-incomplete-v1",
      ]),
    );
    expect(
      moduleCompatibility(manifest, {
        version: "2.0.18",
        apiVersions: [1],
        features,
      }),
    ).toBeNull();
    for (const feature of [
      "module-matrix-field-presentation-v1",
      "module-matrix-quiet-incomplete-v1",
      "module-spreadsheet-controls-v1",
    ])
      expect(
        moduleCompatibility(manifest, {
          version: "2.0.18",
          apiVersions: [1],
          features: features.filter((item) => item !== feature),
        }),
      ).toContain(feature);
    // The connection settings screen shows the same saved Automatic Take as the Router page.
    expect(features).toContain("module-settings-pages-v1");
    expect(manifest.capabilities).toContain("service.page.routing-settings");
    const settingsPage = manifest.pages?.find(
      (page) => page.placement === "module-settings",
    );
    expect(settingsPage?.sections).toEqual([
      expect.objectContaining({
        type: "custom",
        id: "routing-settings",
        entry: "ui/settings.html",
      }),
    ]);
    expect(
      moduleCompatibility(manifest, {
        version: "2.0.18",
        apiVersions: [1],
        features: features.filter(
          (item) => item !== "module-settings-pages-v1",
        ),
      }),
    ).toContain("module-settings-pages-v1");
    expect(manifest.matrix?.legacy).toMatchObject({
      adapter: type,
      connectionType: type,
      normalize: true,
    });
  },
);

it.each([
  ["aja-kumo", aja, undefined],
  ["blackmagic-videohub", blackmagic, undefined],
  ["evertz-quartz", evertz, undefined],
  ["ross-ultrix-ogp", ross, "ui/logo.svg"],
] as const)(
  "%s declares only its own Router sidebar icon",
  (type, source, icon) => {
    const files = ["module.mjs", "ui/index.html", "ui/settings.html"];
    const manifest = ModuleManifestSchema.parse({
      ...source,
      id: `hubble-${type}`,
      name: type,
      version: "1.1.3",
      entry: "module.mjs",
      files: icon ? [...files, icon] : files,
    });
    const features =
      "minimumVersion" in manifest.host
        ? (manifest.host.requiredFeatures ?? [])
        : [];
    const routing = manifest.pages?.find((page) => page.id === "routing");
    expect(routing?.icon).toBe(icon);
    expect(features.includes("module-page-icons-v1")).toBe(!!icon);
    if (icon)
      // Hubble 2.1.0 and older lack the feature, so they keep the previous release.
      expect(
        moduleCompatibility(manifest, {
          version: "2.1.0",
          apiVersions: [1],
          features: features.filter((item) => item !== "module-page-icons-v1"),
        }),
      ).toContain("module-page-icons-v1");
  },
);
