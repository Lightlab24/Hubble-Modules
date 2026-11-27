/**
 * The page's three views, in the order of its View control. Each is also a part the sidebar's
 * Open in its own window › offers: that window shows only that view. HubDash saves the `view`
 * with each window it opens again at the next start, and the page saves it as the open tab, so
 * the IDs never change.
 */
export const PAGE_VIEW_IDS = ["tally", "routing", "setup"] as const;

export type PageView = (typeof PAGE_VIEW_IDS)[number];

const TITLES: Record<PageView, string> = { tally: "Tally", routing: "Routing", setup: "Setup" };

/** Each view with the name the View control and the window's title give it. */
export const PAGE_VIEWS: readonly { readonly view: PageView; readonly title: string }[] = PAGE_VIEW_IDS.map((view) => ({
  view,
  title: TITLES[view],
}));

export const isPageView = (value: unknown): value is PageView => PAGE_VIEW_IDS.some((view) => view === value);
