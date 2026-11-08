import { moduleTimecodeIssue } from "@hubble/module-sdk/timecode";

/**
 * A local stand-in for a device. A real module validates against what the device
 * advertises and reports what the device confirms, not what it was asked for.
 */
export interface DeviceState {
  record: boolean;
  bus: "pgm" | "pvw" | "off";
  preset: number;
  cue: string;
  ftb: boolean;
  take: boolean;
  ptz: { x: number; y: number };
  source: string;
  color: string;
  takes: number;
  routes: number;
}

export const SOURCES = [
  { value: "cam1", label: "CAM 1", group: "Cameras" },
  { value: "cam2", label: "CAM 2", group: "Cameras" },
  { value: "cam3", label: "CAM 3", group: "Cameras" },
  { value: "jib", label: "Jib", group: "Cameras" },
  { value: "evs1", label: "EVS 1", group: "Playback" },
  { value: "evs2", label: "EVS 2", group: "Playback" },
  { value: "gfx", label: "Graphics fill", group: "Graphics" },
  { value: "clock", label: "Clock", group: "Graphics" },
] as const;

export const PTZ = {
  pan: { min: -170, max: 170 },
  tilt: { min: -30, max: 90 },
};
/** Stands in for a preset the device refuses, to show a rejected command. */
export const LOCKED_PRESET = 13;

export function initialDevice(): DeviceState {
  return {
    record: false,
    bus: "pgm",
    preset: 1,
    cue: "01:00:00:00",
    ftb: false,
    take: false,
    ptz: { x: 0, y: 0 },
    source: "cam1",
    color: "#0090ff",
    takes: 0,
    routes: 64,
  };
}

const fail = (message: string): never => {
  throw new Error(message);
};

/** Applies one validated control change. Throws with operator-facing text. */
export function applyControl(
  device: DeviceState,
  request: unknown,
): DeviceState {
  if (!request || typeof request !== "object" || Array.isArray(request))
    return fail("Expected a control and a value");
  const { control, value } = request as { control?: unknown; value?: unknown };
  switch (control) {
    case "record":
    case "ftb":
      if (typeof value !== "boolean")
        return fail(`${control} must be on or off`);
      return { ...device, [control]: value };
    case "bus":
      if (value !== "pgm" && value !== "pvw" && value !== "off")
        return fail("Bus must be Program, Preview or Off");
      return { ...device, bus: value };
    case "preset":
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 99
      )
        return fail("Preset must be a whole number from 1 to 99");
      if (value === LOCKED_PRESET)
        return fail(`Preset ${LOCKED_PRESET} is locked on this device`);
      return { ...device, preset: value };
    case "cue": {
      const issue =
        typeof value === "string"
          ? moduleTimecodeIssue(value, "25")
          : "Cue must be text";
      if (issue) return fail(issue);
      return { ...device, cue: value as string };
    }
    case "ptz": {
      const point = value as { x?: unknown; y?: unknown } | null;
      if (
        !point ||
        typeof point.x !== "number" ||
        typeof point.y !== "number" ||
        point.x < PTZ.pan.min ||
        point.x > PTZ.pan.max ||
        point.y < PTZ.tilt.min ||
        point.y > PTZ.tilt.max
      )
        return fail("Pan or tilt is out of range");
      return { ...device, ptz: { x: point.x, y: point.y } };
    }
    case "source":
      if (!SOURCES.some((source) => source.value === value))
        return fail("That source is not on this router");
      return { ...device, source: value as string };
    case "color":
      if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value))
        return fail("Colour must be #RRGGBB");
      return { ...device, color: value.toLowerCase() };
    default:
      return fail("Unknown control");
  }
}

/** Momentary TAKE: down shows the tally, up completes one take. */
export function applyPress(device: DeviceState, request: unknown): DeviceState {
  const { button, down } = (request ?? {}) as {
    button?: unknown;
    down?: unknown;
  };
  if (button !== "take" || typeof down !== "boolean")
    return fail("Unknown button");
  return down
    ? { ...device, take: true }
    : { ...device, take: false, takes: device.takes + (device.take ? 1 : 0) };
}

export function filterSources(query: unknown) {
  const text = typeof query === "string" ? query.trim().toLowerCase() : "";
  return SOURCES.filter(
    (source) =>
      !text ||
      source.label.toLowerCase().includes(text) ||
      source.group.toLowerCase().includes(text),
  );
}
