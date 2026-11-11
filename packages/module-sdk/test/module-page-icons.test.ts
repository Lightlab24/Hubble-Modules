import { describe, expect, it } from "vitest"
import { ModuleManifestSchema } from "../src/index.js"

const manifest = (page: Record<string, unknown>, features = ["module-pages-v1", "module-page-icons-v1"]) => ({
  formatVersion: 1,
  id: "example-icons",
  name: "Icons",
  version: "1.0.0",
  apiVersion: 1,
  host: { minimumVersion: "2.0.2", requiredFeatures: features },
  configVersion: 1,
  entry: "module.mjs",
  files: ["module.mjs", "ui/logo.svg", "ui/photo.png"],
  capabilities: [],
  actions: [],
  feedback: [],
  settings: [],
  pages: [
    {
      id: "cameras",
      label: "Cameras",
      sections: [{ type: "status", id: "status", label: "Status", fields: [] }],
      ...page,
    },
  ],
})

describe("module page icons", () => {
  it("accepts an SVG, PNG, JPEG or WebP package file under ui/", () => {
    expect(ModuleManifestSchema.parse(manifest({ icon: "ui/logo.svg" })).pages?.[0]?.icon).toBe(
      "ui/logo.svg",
    )
    expect(ModuleManifestSchema.parse(manifest({ icon: "ui/photo.png" })).pages?.[0]?.icon).toBe(
      "ui/photo.png",
    )
  })

  it("requires the host feature, a listed file, an image type and a sidebar page", () => {
    expect(() =>
      ModuleManifestSchema.parse(manifest({ icon: "ui/logo.svg" }, ["module-pages-v1"])),
    ).toThrow("module-page-icons-v1")
    expect(() => ModuleManifestSchema.parse(manifest({ icon: "ui/missing.svg" }))).toThrow(
      "one of the package files",
    )
    expect(() => ModuleManifestSchema.parse(manifest({ icon: "module.mjs" }))).toThrow()
    expect(() => ModuleManifestSchema.parse(manifest({ icon: "ui/logo.gif" }))).toThrow()
    expect(() => ModuleManifestSchema.parse(manifest({ icon: "https://example.com/a.svg" }))).toThrow()
  })
})
