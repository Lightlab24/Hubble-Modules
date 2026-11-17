import type { ModuleManifest, ModuleValues } from "@hubble/module-sdk";

export const DEFAULT_PORT = 18181;

export const settings = [
  {
    id: "host",
    label: "Monitor IP address",
    type: "text",
    required: true,
    default: "",
    description: "The address in the monitor's System menu. A host name works too.",
  },
  {
    id: "port",
    label: "Port",
    type: "number",
    required: true,
    default: DEFAULT_PORT,
    integer: true,
    min: 1,
    max: 65535,
    description: "FSI monitors take remote keys on port 18181.",
  },
  {
    id: "whenInUse",
    label: "When another app is connected",
    type: "choice",
    required: true,
    default: "wait",
    choices: [
      { id: "wait", label: "Don't send the key" },
      { id: "send", label: "Send anyway" },
    ],
    description:
      "Before each key Hubble checks whether another app on this Mac, such as LiveGrade or IP Remote Utility, is connected to the monitor. FSI warns that a second connection may interrupt that app. Hubble can't see apps on other computers.",
  },
] satisfies ModuleManifest["settings"];

export interface MonitorSettings {
  readonly host: string;
  readonly port: number;
  readonly whenInUse: "wait" | "send";
}

export function readSettings(values: ModuleValues): MonitorSettings | string {
  const host = typeof values.host === "string" ? values.host.trim() : "";
  if (!host) return "Enter the monitor's IP address in this connection's settings";
  const port = values.port ?? DEFAULT_PORT;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    return "The port must be a whole number from 1 to 65535";
  return { host, port, whenInUse: values.whenInUse === "send" ? "send" : "wait" };
}
