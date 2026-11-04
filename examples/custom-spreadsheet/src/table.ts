import type { ModulePageTable } from "@hubble/module-sdk";
import { routes, routesForArea, routeAreas } from "./routes.js";

const routeChoices = (items: readonly (typeof routes)[number][]) =>
  items.map((route) => ({
    id: route.value,
    label: route.label,
    ...("group" in route ? { group: route.group } : {}),
  }));
export const documentId = "patch";
export const patchTable: ModulePageTable = {
  type: "table",
  id: "rows",
  label: "Patch workbook",
  source: "document",
  documentId,
  maxRows: 16,
  autoNumber: "count",
  choiceDependencies: { route: ["area"] },
  workbook: {
    stateKey: "rowsView",
    formulaChoiceValues: "label",
    columns: {
      route: { fill: "copy" },
      count: { formula: true, fill: "series" },
      name: { formula: true, fill: "series" },
      address: { fill: "series" },
      note: { fill: "copy" },
      color: { editor: "color", fill: "copy" },
    },
  },
  columns: [
    {
      id: "route",
      label: "Route",
      type: "choice",
      default: "none",
      required: true,
      choices: routeChoices(routes),
    },
    {
      id: "count",
      label: "Number",
      type: "number",
      default: null,
      required: false,
      min: 0,
      max: 1000000,
      integer: true,
    },
    {
      id: "enabled",
      label: "Enabled",
      type: "boolean",
      default: false,
      required: false,
    },
    {
      id: "name",
      label: "Name",
      type: "text",
      default: "",
      required: false,
      validation: { maxLength: 1000, message: "Enter up to 1,000 characters" },
    },
    {
      id: "address",
      label: "Address",
      type: "text",
      default: "",
      required: false,
      validation: { maxLength: 1000, message: "Enter up to 1,000 characters" },
    },
    {
      id: "note",
      label: "Note",
      type: "text",
      default: "",
      required: false,
      validation: { maxLength: 1000, message: "Enter up to 1,000 characters" },
    },
    {
      id: "mode",
      label: "Row mode",
      type: "choice",
      default: "editable",
      required: true,
      choices: [
        { id: "editable", label: "Editable" },
        { id: "locked", label: "Number locked" },
        { id: "unavailable", label: "Name unavailable" },
      ],
    },
    {
      id: "area",
      label: "Area",
      type: "choice",
      default: "any",
      required: false,
      choices: [...routeAreas],
    },
    {
      id: "color",
      label: "Color",
      type: "text",
      default: "#287FA8",
      required: false,
    },
  ],
  fieldRules: [
    ...["studio", "remote"].map((area) => ({
      id: `routes-${area}`,
      dependencies: ["area"],
      when: [{ field: "area", equals: area }],
      fields: { route: { choices: routeChoices(routesForArea(area)) } },
    })),
    {
      id: "locked-number",
      dependencies: ["mode"],
      when: [{ field: "mode", equals: "locked" }],
      fields: {
        count: { availability: "read-only" },
        enabled: { availability: "read-only" },
      },
    },
    {
      id: "unavailable-name",
      dependencies: ["mode"],
      when: [{ field: "mode", equals: "unavailable" }],
      fields: { name: { availability: "unavailable", blank: true } },
    },
  ],
};

export const patchGroup = {
  id: "patch-details",
  label: "Patch details",
  fields: ["name", "address", "note", "area", "color"],
  defaultExpanded: false,
};
export const patchCustomTable: ModulePageTable = {
  ...patchTable,
  workbook: {
    ...patchTable.workbook!,
    stateKey: "customView",
    groups: [patchGroup],
  },
};
