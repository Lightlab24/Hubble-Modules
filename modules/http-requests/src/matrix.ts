import { ModuleMatrixSchema, type ModuleValues } from "@hubble/module-sdk";

const methods = ["get", "post", "put", "patch", "delete"] as const;
const bodyMethods = ["post", "put", "patch", "delete"];

export const matrix = ModuleMatrixSchema.parse({
  id: "requests",
  label: "HTTP Requests",
  actionId: "matrix",
  feedbackId: "matrix",
  legacy: {
    adapter: "generic-http",
    normalize: true,
    connectionType: "generic-http",
  },
  primaryField: "requestTarget",
  variants: methods.map((method) => ({
    when: [{ field: "column.commandId", values: [method] }],
    fields: { actionType: { default: method } },
  })),
  fields: [
    {
      fill: "copy",
      id: "enabled",
      label: "Enabled",
      type: "boolean",
      default: true,
      width: 88,
    },
    {
      fill: "copy",
      id: "actionType",
      label: "Method",
      type: "choice",
      default: "get",
      width: 120,
      choices: methods.map((value) => ({ value, label: value.toUpperCase() })),
    },
    {
      fill: "copy",
      id: "requestTarget",
      label: "Request target",
      type: "text",
      default: "",
      formula: true,
      width: 300,
    },
    {
      fill: "copy",
      id: "header",
      label: "Headers",
      type: "text",
      default: "",
      formula: true,
      width: 280,
    },
    {
      fill: "copy",
      id: "body",
      label: "Body",
      type: "text",
      default: "",
      formula: true,
      width: 280,
      enabledWhen: [{ field: "actionType", values: bodyMethods }],
    },
    {
      fill: "copy",
      id: "contenttype",
      label: "Content type",
      type: "choice",
      default: "application/json",
      formula: true,
      width: 220,
      enabledWhen: [{ field: "actionType", values: ["post", "put", "patch"] }],
      choices: [
        "application/json",
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/xml",
        "text/xml",
        "application/octet-stream",
      ].map((value) => ({ value, label: value })),
    },
  ],
});

/** Convert stable Matrix sources into this module's public request actions. */
export function matrixRequest(fields: ModuleValues): {
  id: string;
  fields: ModuleValues;
} {
  const values = fields.values;
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("HTTP Matrix values are unavailable");
  const value = values as ModuleValues;
  const method = String(value.actionType);
  if (!methods.some((item) => item === method))
    throw new Error("Choose a supported HTTP method");
  return {
    id: `generic-http.${method}`,
    fields: {
      ...(fields.actionId === undefined ? {} : { actionId: fields.actionId }),
      ...(fields.actionColumnId === undefined
        ? {}
        : { actionColumnId: fields.actionColumnId }),
      requestTarget: value.requestTarget ?? "",
      header: value.header ?? "",
      ...(bodyMethods.includes(method) ? { body: value.body ?? "" } : {}),
      ...(["post", "put", "patch"].includes(method)
        ? { contenttype: value.contenttype ?? "application/json" }
        : {}),
    },
  };
}
