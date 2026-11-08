// No imports: the host's custom-page control bundle uses this without the schema library.
/** Drop-frame rates use a semicolon before the frames, as in 01:00:00;00. */
export const MODULE_TIMECODE_FRAME_RATES = [
  "23.976",
  "24",
  "25",
  "29.97",
  "29.97df",
  "30",
  "50",
  "59.94",
  "59.94df",
  "60",
] as const;
export type ModuleTimecodeFrameRate =
  (typeof MODULE_TIMECODE_FRAME_RATES)[number];
const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})$/u;
/** Returns why a value is not timecode at this rate, or null when it is. */
export function moduleTimecodeIssue(
  value: string,
  frameRate: ModuleTimecodeFrameRate,
): string | null {
  const match = TIMECODE.exec(value);
  if (!match) return "Use HH:MM:SS:FF, for example 01:00:00:00";
  const [, hh, mm, ss, separator, ff] = match;
  const dropFrame = frameRate.endsWith("df");
  const fps = Math.round(Number.parseFloat(frameRate));
  if (Number(hh) > 23) return "Hours go up to 23";
  if (Number(mm) > 59 || Number(ss) > 59)
    return "Minutes and seconds go up to 59";
  if (Number(ff) >= fps)
    return `At ${frameRate} fps, frames go up to ${String(fps - 1).padStart(2, "0")}`;
  if (separator === ";" && !dropFrame)
    return "Only drop-frame timecode uses a semicolon";
  // Drop-frame skips the first frame numbers of each minute except every tenth.
  const dropped = fps === 60 ? 4 : 2;
  if (
    dropFrame &&
    Number(ss) === 0 &&
    Number(ff) < dropped &&
    Number(mm) % 10 !== 0
  )
    return `Drop-frame skips frames 00 to ${String(dropped - 1).padStart(2, "0")} at the start of this minute`;
  return null;
}
