import { expect, it } from "vitest";
import { ModuleManifestSchema, moduleCompatibility } from "../src/index.js";
import { resolveModuleMatrixField } from "../src/matrix.js";
import { createModulePackage, inspectModulePackage } from "../src/package.js";

const feature = "module-matrix-field-presentation-v1";
const features = [
  "module-matrix-v1",
  "module-feedback-observers-v1",
  "module-matrix-row-fields-v1",
];
function definition(presentation: object) {
  return {
    formatVersion: 1,
    apiVersion: 1,
    configVersion: 1,
    id: "example-field-colors",
    name: "Field colors",
    version: "1.0.0",
    entry: "module.mjs",
    files: ["module.mjs"],
    capabilities: [],
    settings: [],
    host: { minimumVersion: "2.0.15", requiredFeatures: features },
    actions: [
      {
        id: "apply",
        label: "Apply",
        description: "Local action",
        fields: [],
        completion: "local",
        timeoutMs: 1000,
      },
    ],
    feedback: [
      { id: "state", label: "State", description: "Local state", fields: [] },
    ],
    matrix: {
      id: "field-colors",
      label: "Field colors",
      actionId: "apply",
      feedbackId: "state",
      primaryField: "actionType",
      fields: [
        { id: "actionType", label: "Action", type: "text", default: "source" },
        {
          id: "module.address",
          label: "Address",
          type: "number",
          default: 1,
          ...presentation,
        },
      ],
    },
  };
}
it.each([
  { textColor: "#159DDD" },
  {
    rules: [
      {
        when: [{ field: "actionType", values: ["source"] }],
        set: { textColor: "#159DDD" },
      },
    ],
  },
])(
  "requires field-presentation support for static and dependent colors: %j",
  (presentation) => {
    const candidate = definition(presentation);
    expect(() => ModuleManifestSchema.parse(candidate)).toThrow(feature);
    const manifest = ModuleManifestSchema.parse({
      ...candidate,
      host: { ...candidate.host, requiredFeatures: [...features, feature] },
    });
    expect(
      moduleCompatibility(manifest, {
        version: "2.0.15",
        apiVersions: [1],
        features,
      }),
    ).toContain(feature);
    expect(
      moduleCompatibility(manifest, {
        version: "2.0.15",
        apiVersions: [1],
        features: [...features, feature],
      }),
    ).toBeNull();
    const archived = inspectModulePackage(
      createModulePackage(
        manifest,
        new Map([["module.mjs", Buffer.from("export const color = true;\n")]]),
      ),
    ).manifest;
    expect(archived.matrix).toEqual(manifest.matrix);
    const field = archived.matrix!.fields.find(
      (item) => item.id === "module.address",
    )!;
    expect(
      resolveModuleMatrixField(field, { actionType: "source" }).textColor,
    ).toBe("#159DDD");
  },
);
it("resolves colors from current row inputs, retaining normal presentation for other actions", () => {
  const candidate = definition({
    rules: [
      {
        when: [{ field: "actionType", values: ["source"] }],
        set: { textColor: "#159DDD" },
      },
      {
        when: [{ field: "actionType", values: ["destination"] }],
        set: { textColor: "#8B5CE5" },
      },
    ],
  });
  const manifest = ModuleManifestSchema.parse({
    ...candidate,
    host: { ...candidate.host, requiredFeatures: [...features, feature] },
  });
  const field = manifest.matrix!.fields.find(
    (item) => item.id === "module.address",
  )!;
  expect(
    resolveModuleMatrixField(field, { actionType: "source" }).textColor,
  ).toBe("#159DDD");
  expect(
    resolveModuleMatrixField(field, { actionType: "destination" }).textColor,
  ).toBe("#8B5CE5");
  expect(
    resolveModuleMatrixField(field, { actionType: "take" }).textColor,
  ).toBeUndefined();
});

it("requires the same capability for colors supplied by a column variant", () => {
  const candidate = definition({});
  const matrix = {
    ...candidate.matrix,
    variants: [
      {
        when: [{ field: "column.commandId", values: ["apply"] }],
        fields: { "module.address": { textColor: "#123456" } },
      },
    ],
  };
  expect(() => ModuleManifestSchema.parse({ ...candidate, matrix })).toThrow(
    feature,
  );
  expect(() =>
    ModuleManifestSchema.parse({
      ...candidate,
      matrix,
      host: {
        ...candidate.host,
        requiredFeatures: [...features, feature, "module-matrix-context-v1"],
      },
    }),
  ).not.toThrow();
});
