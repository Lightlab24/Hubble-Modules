/**
 * The parts of the page Hubble's sidebar offers under Open in its own window ›, each opened in a HubDash window that
 * shows only that part, titled "Hubble - Cyanview - <title>". A part's view is its tab's own id, so it means the same
 * part after a restart, and the page asks for the same window when a link leads from one part to another.
 * Firmware is always listed: every worker can take a firmware file.
 */
export const windowParts = [
  { view: 'devices', title: 'Devices' },
  { view: 'setup', title: 'Camera Configuration' },
  { view: 'assignment', title: 'REMI Matrix' },
  { view: 'firmware', title: 'Firmware' },
  { view: 'defaults', title: 'Defaults' },
] as const;

export type WindowPartView = typeof windowParts[number]['view'];

/** The page's tabs each part shows: Devices took over Network Discovery, and REMI Matrix shows its two views. */
export const windowPartTabs: Readonly<Record<WindowPartView, readonly string[]>> = {
  devices: ['devices', 'discovery'],
  setup: ['setup'],
  assignment: ['assignment', 'cameras'],
  firmware: ['firmware'],
  defaults: ['defaults'],
};

/** The part a tab belongs to, or null for a tab no part shows. */
export function windowPartOfTab(tab: string): WindowPartView | null {
  return windowParts.find(part => windowPartTabs[part.view].includes(tab))?.view ?? null;
}
