export const ROUTER_VIEW_ZOOM_STORAGE_KEY = "hubble.router-view-zoom.v1";

export const ROUTER_VIEW_ZOOM_LEVELS = Object.freeze([
  75, 90, 100, 110, 125, 150,
] as const);

export type RouterViewZoom = (typeof ROUTER_VIEW_ZOOM_LEVELS)[number];
export type RouterViewZoomDirection = "decrease" | "increase";
export type RouterViewZoomShortcut = RouterViewZoomDirection | "reset";

export const DEFAULT_ROUTER_VIEW_ZOOM: RouterViewZoom = 100;
export const MINIMUM_ROUTER_VIEW_ZOOM: RouterViewZoom = 75;
export const MAXIMUM_ROUTER_VIEW_ZOOM: RouterViewZoom = 150;

interface StoredRouterViewZoom {
  readonly version: 1;
  readonly zoom: RouterViewZoom;
}

type RouterViewZoomKeyboardEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "defaultPrevented"
  | "isComposing"
  | "key"
  | "metaKey"
  | "shiftKey"
>;

export function stepRouterViewZoom(
  current: RouterViewZoom,
  direction: RouterViewZoomDirection,
): RouterViewZoom {
  const currentIndex = ROUTER_VIEW_ZOOM_LEVELS.indexOf(current);
  const defaultIndex = ROUTER_VIEW_ZOOM_LEVELS.indexOf(
    DEFAULT_ROUTER_VIEW_ZOOM,
  );
  const safeIndex = currentIndex < 0 ? defaultIndex : currentIndex;
  const offset = direction === "increase" ? 1 : -1;
  const nextIndex = Math.min(
    ROUTER_VIEW_ZOOM_LEVELS.length - 1,
    Math.max(0, safeIndex + offset),
  );
  return ROUTER_VIEW_ZOOM_LEVELS[nextIndex] ?? DEFAULT_ROUTER_VIEW_ZOOM;
}

export function resetRouterViewZoom(): RouterViewZoom {
  return DEFAULT_ROUTER_VIEW_ZOOM;
}

export function resolveRouterViewZoomShortcut(
  event: RouterViewZoomKeyboardEvent,
): RouterViewZoomShortcut | null {
  const hasPrimaryModifier = event.metaKey !== event.ctrlKey;
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    !hasPrimaryModifier
  ) {
    return null;
  }

  if (event.code === "Equal" || event.key === "+" || event.key === "=")
    return "increase";
  if (!event.shiftKey && (event.code === "Minus" || event.key === "-"))
    return "decrease";
  if (
    !event.shiftKey &&
    (event.code === "Digit0" || event.code === "Numpad0" || event.key === "0")
  ) {
    return "reset";
  }
  return null;
}

export function loadRouterViewZoom(
  storage: Pick<Storage, "getItem">,
): RouterViewZoom {
  let parsed: unknown;
  try {
    const stored = storage.getItem(ROUTER_VIEW_ZOOM_STORAGE_KEY);
    if (stored === null) return DEFAULT_ROUTER_VIEW_ZOOM;
    parsed = JSON.parse(stored) as unknown;
  } catch {
    return DEFAULT_ROUTER_VIEW_ZOOM;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return DEFAULT_ROUTER_VIEW_ZOOM;
  }
  const candidate = parsed as Readonly<Record<string, unknown>>;
  return candidate["version"] === 1 && isRouterViewZoom(candidate["zoom"])
    ? candidate["zoom"]
    : DEFAULT_ROUTER_VIEW_ZOOM;
}

export function saveRouterViewZoom(
  storage: Pick<Storage, "setItem">,
  zoom: RouterViewZoom,
): void {
  const preference: StoredRouterViewZoom = Object.freeze({
    version: 1,
    zoom: isRouterViewZoom(zoom) ? zoom : DEFAULT_ROUTER_VIEW_ZOOM,
  });
  try {
    storage.setItem(ROUTER_VIEW_ZOOM_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Router zoom remains usable when browser preference storage is unavailable.
  }
}

function isRouterViewZoom(value: unknown): value is RouterViewZoom {
  return ROUTER_VIEW_ZOOM_LEVELS.some((level) => level === value);
}
