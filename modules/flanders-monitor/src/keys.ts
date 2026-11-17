/**
 * The monitor keys Flanders Scientific publishes for remote control of XMP
 * series monitors, from FSI's "Flanders Controls" shell scripts. `code` is the
 * key byte in the packet. Keep `id` stable: saved buttons store it.
 */
export interface FlandersKey {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly code: number;
}

export const KEYS: readonly FlandersKey[] = [
  { id: "sdi-1", label: "SDI 1", group: "Inputs", code: 0x11 },
  { id: "sdi-2", label: "SDI 2", group: "Inputs", code: 0x12 },
  { id: "sdi-3", label: "SDI 3", group: "Inputs", code: 0x13 },
  { id: "sdi-4", label: "SDI 4", group: "Inputs", code: 0x14 },
  { id: "f1", label: "F1", group: "Function keys", code: 0x31 },
  { id: "f2", label: "F2", group: "Function keys", code: 0x32 },
  { id: "f3", label: "F3", group: "Function keys", code: 0x33 },
  { id: "f4", label: "F4", group: "Function keys", code: 0x34 },
  { id: "f5", label: "F5", group: "Function keys", code: 0x35 },
  { id: "menu", label: "Menu", group: "Menu", code: 0x20 },
  { id: "up", label: "Up", group: "Menu", code: 0x21 },
  { id: "down", label: "Down", group: "Menu", code: 0x22 },
  { id: "enter", label: "Enter", group: "Menu", code: 0x25 },
  { id: "volume-up", label: "Volume up", group: "Audio", code: 0x54 },
  { id: "volume-down", label: "Volume down", group: "Audio", code: 0x64 },
  { id: "mute", label: "Mute", group: "Audio", code: 0x44 },
];

const byId = new Map(KEYS.map((key) => [key.id, key]));

export function keyById(id: unknown): FlandersKey | undefined {
  return typeof id === "string" ? byId.get(id) : undefined;
}
