import type { SpreadsheetChoice } from "@hubble/module-sdk/spreadsheet-controls";

export const routes = [
  { value: "input-10", label: "Camera A", group: "Studio" },
  { value: "input-20", label: "Camera B", group: "Studio" },
  { value: "input-30", label: "Camera A", group: "Remote" },
  { value: "input-40", label: "Satellite", group: "Remote" },
  { value: "none", label: "Unpatched" },
] as const satisfies readonly SpreadsheetChoice[];

export const routeAreas = [
  { id: "any", label: "Any area" },
  { id: "studio", label: "Studio" },
  { id: "remote", label: "Remote" },
] as const;
export function routesForArea(area: unknown) {
  return routes.filter(
    (route) =>
      route.value === "none" ||
      area === "any" ||
      area === undefined ||
      ("group" in route && route.group.toLowerCase() === area),
  );
}
