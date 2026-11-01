import type { ModuleField } from "@hubble/module-sdk";
import { indicatorValues } from "./presentation.js";
export const text = (id: string, label: string, value = ""): ModuleField => ({
  id,
  label,
  type: "text",
  required: true,
  default: value,
});
export const number = (
  id: string,
  label: string,
  value = 0,
  min = 0,
  max = 65534,
): ModuleField => ({
  id,
  label,
  type: "number",
  required: true,
  default: value,
  min,
  max,
  integer: true,
});
export const choice = (
  id: string,
  label: string,
  values: readonly string[],
  value: string,
): ModuleField => ({
  id,
  label,
  type: "choice",
  required: true,
  default: value,
  choices: values.map((id) => ({ id, label: id })),
});
export const listenerFields: ModuleField[] = [
  {
    id: "routingPeer",
    label: "TALLY Switch module",
    type: "choice",
    required: false,
    default: "",
    choices: [],
    choiceProvider: "tally-switch-peers",
    description:
      "Uses the only approved TALLY Switch when blank. If there are several, choose one and grant it data and action access in module permissions.",
  },
  choice("protocol", "TSL version", ["3.1", "5.0"], "3.1"),
  choice("transport", "Transport", ["tcp", "udp"], "tcp"),
  {
    ...text("bindAddress", "Listen address", "0.0.0.0"),
    description:
      "A local IPv4 address, or 0.0.0.0 for all interfaces. The switcher sends to this computer.",
  },
  number("port", "Listen port", 5727, 1, 65535),
  {
    ...text("sourceAddress", "Allowed sender"),
    required: false,
    description:
      "Optional switcher IPv4 address. Leave blank to accept any sender.",
  },
  {
    ...number("staleAfterMs", "Stale timeout (ms)", 0, 0, 3600000),
    description:
      "Use 0 for switchers that send only on change. TCP disconnect always clears tally.",
  },
];
export const feedbackColumns = [
  text("name", "Name", "Camera"),
  number("screen", "Screen"),
  number("address", "Address"),
  choice("indicator", "Program tally", indicatorValues, "default"),
  text("status", "Live tally"),
];
