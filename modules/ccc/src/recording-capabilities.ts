/** CyanView MQTT capabilities are space-delimited hex bytes, indexed from zero. */
export function parseRecordMode(payload: string): "rec-stop" | "toggle" | null {
  const enabled = cameraCapability(payload, 13, 0x80);
  return enabled === null ? null : enabled ? "rec-stop" : "toggle";
}

export function cameraCapability(
  payload: string,
  index: number,
  mask: number,
): boolean | null {
  if (!/^[\da-f]{2}(?: [\da-f]{2}){0,127}$/iu.test(payload)) return null;
  const hex = payload.split(" ")[index];
  if (hex === undefined) return null;
  const byte = Number.parseInt(hex, 16);
  return (byte & mask) !== 0;
}
