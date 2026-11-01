/** Zoom is presentation-only. The parent document persists it through the package bridge. */
let value: string | null = null;
let changed: (value: string) => void = () => {};
export const routerZoomStorage = {
  getItem: (_key: string) => value,
  setItem: (_key: string, next: string) => {
    if (next !== value) {
      value = next;
      changed(next);
    }
  },
};
export function initializeRouterZoom(
  saved: string | null,
  onChange: (value: string) => void,
) {
  value = saved;
  changed = onChange;
}
