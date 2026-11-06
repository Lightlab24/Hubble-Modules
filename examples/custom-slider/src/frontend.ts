import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import {
  mountSlider,
  type SliderControls,
} from "@hubble/module-sdk/slider-controls";
import { createLatestValueQueue } from "./latest-value-queue.js";
import "./frontend.css";

const RANGE = { min: 10, max: 200, step: 0.1, unit: "%" };

const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), { once: true });
const page = await connectModuleFrontend(window, lifetime.signal);

const zoomIn = (state: Awaited<ReturnType<typeof page.state>>) => {
  const zoom = state?.values.zoom;
  return typeof zoom === "number" ? zoom : null;
};

// The local value leads. The device's value is tracked apart from it, so a late
// readback can never pull the thumb back behind a newer edit. Reading it before
// mounting means a reopened page never shows a stale value first.
let confirmed = zoomIn(await page.state());
let local = confirmed ?? 100;
let edited = false;
let error: string | null = null;
const sliders: SliderControls[] = [];
const refresh = () => {
  for (const slider of sliders) slider.refresh();
};

const queue = createLatestValueQueue<number>({
  send: (zoom) => page.call("set-zoom", { zoom }),
  onSettled(result) {
    // A failure of an older value says nothing about the newest one still on its way.
    if (result.newest) error = result.error?.message ?? null;
    refresh();
  },
});

const options = {
  label: "Zoom",
  getState: () => ({
    ...RANGE,
    value: local,
    confirmedValue: confirmed,
    pending: queue.pending,
    error,
  }),
  onValueChange(value: number) {
    local = value;
    edited = true;
    // The other view of this value follows the drag.
    refresh();
  },
  onValueCommit(value: number) {
    error = null;
    queue.push(value);
    refresh();
  },
};
sliders.push(
  await mountSlider({
    ...options,
    root: document.querySelector<HTMLElement>("#inspector")!,
  }),
  await mountSlider({
    ...options,
    root: document.querySelector<HTMLElement>("#cell")!,
    layout: "cell",
  }),
);

const stop = page.subscribe((state) => {
  confirmed = zoomIn(state);
  // Until the operator edits, the device's value is the only one there is.
  if (!edited && confirmed !== null) local = confirmed;
  refresh();
});
lifetime.signal.addEventListener(
  "abort",
  () => {
    stop();
    for (const slider of sliders) slider.dispose();
    page.dispose();
  },
  { once: true },
);
