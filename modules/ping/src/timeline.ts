import type { Series } from "./history.js";
import { formatMs, SCALES_MS } from "./model.js";

/**
 * The ping timeline for one device, drawn on a canvas. Pinch (or Ctrl and the
 * wheel) zooms the time scale around the pointer, two fingers or a drag move
 * through time, and it follows the present until it is moved away from it.
 * Pinching over the ms numbers changes the height scale instead; a bar taller
 * than a set scale is cut off at the top with a light cap.
 */
export const MIN_SPAN_MS = 10_000;
export const MAX_SPAN_MS = 24 * 60 * 60 * 1000;
const LEFT = 44;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 22;
/** The widest a bar gets. Zooming in stops where one ping would be wider than this. */
export const MAX_BAR = 2;
/** How much of its slot a bar fills; the rest is the hairline between it and the next. */
const BAR_FILL = 0.78;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10_800, 21_600].map((seconds) => seconds * 1000);

export interface TimelineWindow {
  from: number;
  to: number;
  points: number;
}
export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  /** The stretch of time on show changed, so fresh results are wanted. */
  onWindow(): void;
  /** What is under the pointer, or null when it leaves. */
  onHover(text: string | null): void;
  /** Whether the timeline follows the present changed. */
  onFollow(following: boolean): void;
  /** A pinch over the ms numbers asked for this scale; null is Auto. */
  onScale(ms: number | null): void;
  readonly now?: () => number;
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
/** How far a pinch over the ms numbers has to go to move the scale one step. */
const SCALE_PINCH = 20;
/** The height of the cap on a bar that goes past the top of the scale. */
const CAP = 3;
const HINT = "Pinch here to change the scale · double-click for Auto";
function niceCeiling(value: number) {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, 1e-9)));
  for (const step of [1, 2, 4, 5, 8, 10]) if (value <= step * power) return step * power;
  return 10 * power;
}

/**
 * Where a bin's bar goes: its colour and how much of the height it takes.
 * A bin with any lost ping is a full-height red bar, so every loss looks the same
 * whether the bar holds one ping or several.
 */
export function barOf(series: Series, index: number, limit: number | null): { tone: "ok" | "warn" | "bad"; value: number | null; partLost: boolean } | null {
  const sent = series.sent[index] ?? 0;
  if (!sent) return null;
  const lost = series.lost[index] ?? 0;
  const worst = series.max[index] ?? null;
  if (lost > 0 || worst === null) return { tone: "bad", value: null, partLost: lost < sent };
  return { tone: limit !== null && worst > limit ? "warn" : "ok", value: worst, partLost: false };
}

export function drawStrip(canvas: HTMLCanvasElement, series: Series | undefined, limit: number | null) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!series) return;
  const style = getComputedStyle(canvas);
  // A custom property keeps its leading space, which a canvas refuses as a colour.
  const colors = { ok: style.getPropertyValue("--ping-ok").trim(), warn: style.getPropertyValue("--ping-warn").trim(), bad: style.getPropertyValue("--ping-bad").trim() };
  const count = series.sent.length;
  let top = limit !== null ? limit * 1.6 : 0;
  for (const value of series.max) if (value !== null && value > top) top = value;
  top = Math.max(top, 1);
  const step = width / count;
  for (let index = 0; index < count; index++) {
    const bar = barOf(series, index, limit);
    if (!bar) continue;
    const barHeight = bar.value === null ? height : clamp((bar.value / top) * height, 2 * ratio, height);
    context.fillStyle = colors[bar.tone];
    context.fillRect(index * step, height - barHeight, Math.max(1, step * 0.8), barHeight);
  }
}

export function createTimeline(options: TimelineOptions) {
  const { canvas } = options;
  const clock = options.now ?? Date.now;
  let spanMs = 600_000;
  let pingMs = 1000;
  /** The right edge of the view, or null while it follows the present. */
  let end: number | null = null;
  let series: Series | undefined;
  let limit: number | null = null;
  /** The answer time at the top of the scale the user chose, or null for Auto. */
  let scaleMs: number | null = null;
  /** The top of the scale as last drawn, Auto or not. */
  let drawnTop = 1;
  let scalePinch = 0;
  let scalePinchAt = 0;
  let dragging: { x: number; end: number } | undefined;
  /**
   * A Show last choice that is waiting for its own results. The view keeps the old stretch and its
   * bars until they arrive, then both change in one frame, so nothing is drawn at the wrong scale.
   */
  let pending: { spanMs: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let frame = 0;

  const plotWidth = () => Math.max(50, canvas.clientWidth - LEFT - RIGHT);
  const right = () => end ?? clock();
  /** The shortest stretch the view can show: bars touch, so any closer and one ping would be a wide block. */
  const minSpan = () => Math.max(MIN_SPAN_MS, (plotWidth() / MAX_BAR) * pingMs);

  function setEnd(next: number) {
    const now = clock();
    const before = end;
    // Within a bar's width of the present counts as the present, so it starts following again.
    end = next >= now - spanMs / plotWidth() ? null : Math.max(next, now - MAX_SPAN_MS + spanMs);
    if ((before === null) !== (end === null)) options.onFollow(end === null);
  }

  function changed() {
    // What was under the pointer has moved away.
    options.onHover(null);
    schedule();
    options.onWindow();
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);
    const style = getComputedStyle(canvas);
    const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const tones = { ok: color("--ping-ok", "#63bc9c"), warn: color("--ping-warn", "#dfbc72"), bad: color("--ping-bad", "#e5766a") };
    const quiet = color("--hubble-text-secondary", "#b2b2b2");
    const line = color("--hubble-line", "#262626");
    const font = color("--hubble-font", "system-ui");
    const to = right();
    const from = to - spanMs;
    const width_ = plotWidth();
    const plotHeight = cssHeight - TOP - BOTTOM;
    const xOf = (time: number) => LEFT + ((time - from) / spanMs) * width_;

    let top = limit !== null ? limit * 1.25 : 0;
    if (scaleMs !== null) top = scaleMs;
    else {
      if (series)
        for (let index = 0; index < series.max.length; index++) {
          const start = series.from + index * series.stepMs;
          const value = series.max[index];
          if (value !== null && value !== undefined && value > top && start + series.stepMs > from && start < to) top = value;
        }
      top = niceCeiling(Math.max(top, 1));
    }
    drawnTop = top;
    const yOf = (value: number) => TOP + plotHeight - (Math.min(value, top) / top) * plotHeight;

    context.font = `11px ${font}`;
    context.textBaseline = "middle";
    context.lineWidth = 1;
    for (let step = 0; step <= 4; step++) {
      const value = (top / 4) * step;
      const y = Math.round(yOf(value)) + 0.5;
      context.strokeStyle = line;
      context.beginPath();
      context.moveTo(LEFT, y);
      context.lineTo(LEFT + width_, y);
      context.stroke();
      context.fillStyle = quiet;
      context.textAlign = "right";
      context.fillText(top >= 8 ? String(Math.round(value)) : String(Number(value.toFixed(2))), LEFT - 8, y);
    }
    context.font = `10px ${font}`;
    context.fillText("ms", LEFT - 8, cssHeight - 8);

    if (series) {
      context.save();
      context.beginPath();
      context.rect(LEFT, TOP, width_, plotHeight);
      context.clip();
      const barWidth = (series.stepMs / spanMs) * width_;
      const capped: number[] = [];
      for (let index = 0; index < series.sent.length; index++) {
        const bar = barOf(series, index, limit);
        if (!bar) continue;
        const x = xOf(series.from + index * series.stepMs);
        if (x + barWidth < LEFT || x > LEFT + width_) continue;
        // Dense thin bars with a hairline between them, as in the approved mockup.
        const drawn = Math.max(1, barWidth * BAR_FILL);
        context.fillStyle = tones[bar.tone];
        if (bar.value === null) {
          context.globalAlpha = 0.8;
          context.fillRect(x, TOP, Math.max(1, barWidth), plotHeight);
          context.globalAlpha = 1;
          continue;
        }
        const y = Math.min(yOf(bar.value), TOP + plotHeight - 1);
        context.fillRect(x, y, drawn, TOP + plotHeight - y);
        if (bar.value > top) capped.push(x, drawn);
      }
      // A bar cut off by the scale ends in a light cap, so it never reads as the real height.
      context.fillStyle = color("--hubble-text-strong", "#f4f4f4");
      for (let index = 0; index < capped.length; index += 2) context.fillRect(capped[index]!, TOP, capped[index + 1]!, CAP);
      context.restore();
    }

    if (limit !== null && limit <= top) {
      const y = Math.round(yOf(limit)) + 0.5;
      context.strokeStyle = tones.warn;
      context.setLineDash([5, 4]);
      context.beginPath();
      context.moveTo(LEFT, y);
      context.lineTo(LEFT + width_, y);
      context.stroke();
      context.setLineDash([]);
      const label = `Alert over ${limit} ms`;
      context.font = `11px ${font}`;
      context.textAlign = "left";
      const labelWidth = context.measureText(label).width;
      context.fillStyle = color("--hubble-bar", "#131313");
      context.globalAlpha = 0.9;
      context.fillRect(LEFT + 6, y - 20, labelWidth + 10, 16);
      context.globalAlpha = 1;
      context.fillStyle = tones.warn;
      context.fillText(label, LEFT + 11, y - 12);
    }

    // Time marks: the step that gives about six across the view.
    const tick = TICK_STEPS.find((step) => spanMs / step <= 7) ?? TICK_STEPS.at(-1)!;
    const offset = new Date(to).getTimezoneOffset() * 60_000;
    const withSeconds = tick < 60_000;
    context.font = `11px ${font}`;
    context.fillStyle = quiet;
    context.textBaseline = "alphabetic";
    for (let time = Math.ceil((from - offset) / tick) * tick + offset; time <= to; time += tick) {
      const x = xOf(time);
      const text = new Date(time).toLocaleTimeString([], withSeconds ? { hour: "numeric", minute: "2-digit", second: "2-digit" } : { hour: "numeric", minute: "2-digit" });
      const half = context.measureText(text).width / 2;
      context.textAlign = "center";
      context.strokeStyle = line;
      context.beginPath();
      context.moveTo(Math.round(x) + 0.5, TOP + plotHeight);
      context.lineTo(Math.round(x) + 0.5, TOP + plotHeight + 4);
      context.stroke();
      context.fillText(text, clamp(x, LEFT + half, LEFT + width_ - half), cssHeight - 5);
    }
  }

  /** Makes a waiting Show last choice the view. */
  function commit() {
    if (!pending) return;
    clearTimeout(pending.timer);
    spanMs = pending.spanMs;
    pending = undefined;
    const was = end;
    end = null;
    if (was !== null) options.onFollow(true);
    schedule();
  }

  function zoomAbout(fraction: number, factor: number) {
    // A pinch or a scroll is about what is on screen now, so a waiting choice takes effect first.
    commit();
    const to = right();
    const at = to - spanMs + fraction * spanMs;
    const next = clamp(spanMs * factor, minSpan(), MAX_SPAN_MS);
    if (next === spanMs) return;
    spanMs = next;
    setEnd(at + (1 - fraction) * next);
    changed();
  }
  function panBy(ms: number) {
    if (!ms) return;
    commit();
    setEnd(right() + ms);
    changed();
  }
  /** Whether a point is over the ms numbers left of the bars. */
  const overNumbers = (clientX: number) => clientX - canvas.getBoundingClientRect().left < LEFT;
  /**
   * Moves the scale one step for each stretch of a pinch: apart makes the bars taller (a smaller
   * scale), together makes them shorter. From Auto it starts at the scale on screen.
   */
  function pinchScale(deltaY: number) {
    // A pause starts a new pinch, so what was left of the last one doesn't carry over.
    const at = performance.now();
    if (at - scalePinchAt > 300) scalePinch = 0;
    scalePinchAt = at;
    scalePinch += deltaY;
    if (Math.abs(scalePinch) < SCALE_PINCH) return;
    const taller = scalePinch < 0;
    scalePinch = 0;
    const from = scaleMs ?? drawnTop;
    const next = taller ? [...SCALES_MS].reverse().find((ms) => ms < from) : SCALES_MS.find((ms) => ms > from);
    if (next === undefined || next === scaleMs) return;
    scaleMs = next;
    schedule();
    options.onScale(next);
  }
  const fractionAt = (clientX: number) => clamp((clientX - canvas.getBoundingClientRect().left - LEFT) / plotWidth(), 0, 1);

  const controller = new AbortController();
  const listen = { signal: controller.signal };
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      // A trackpad pinch arrives as a wheel event with Ctrl held.
      if (event.ctrlKey && overNumbers(event.clientX)) pinchScale(event.deltaY);
      else if (event.ctrlKey) zoomAbout(fractionAt(event.clientX), Math.exp(event.deltaY * 0.01));
      else {
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        panBy(delta * (spanMs / plotWidth()) * (event.deltaMode === 1 ? 16 : 1));
      }
    },
    { ...listen, passive: false },
  );
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      dragging = { x: event.clientX, end: right() };
      canvas.setPointerCapture(event.pointerId);
    },
    listen,
  );
  canvas.addEventListener(
    "pointermove",
    (event) => {
      if (dragging) {
        setEnd(dragging.end - (event.clientX - dragging.x) * (spanMs / plotWidth()));
        changed();
        return;
      }
      const numbers = overNumbers(event.clientX);
      canvas.style.cursor = numbers ? "ns-resize" : "";
      if (numbers) {
        options.onHover(HINT);
        return;
      }
      if (!series) return;
      const time = right() - spanMs + fractionAt(event.clientX) * spanMs;
      const index = Math.floor((time - series.from) / series.stepMs);
      const bar = index >= 0 && index < series.sent.length ? barOf(series, index, limit) : null;
      const when = new Date(series.from + Math.max(0, index) * series.stepMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
      if (!bar) options.onHover(`${when} · no pings`);
      else if (bar.value === null) options.onHover(`${when} · ${bar.partLost ? `${series.lost[index]} of ${series.sent[index]} pings lost` : "no answer"}`);
      else options.onHover(`${when} · ${formatMs(bar.value)}${bar.value > drawnTop ? " · past the top of the scale" : ""}`);
    },
    listen,
  );
  const release = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerup", release, listen);
  canvas.addEventListener("pointercancel", release, listen);
  canvas.addEventListener("pointerleave", () => options.onHover(null), listen);
  canvas.addEventListener(
    "dblclick",
    (event) => {
      if (!overNumbers(event.clientX) || scaleMs === null) return;
      scaleMs = null;
      schedule();
      options.onScale(null);
    },
    listen,
  );
  canvas.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "ArrowLeft") panBy(-spanMs / 10);
      else if (event.key === "ArrowRight") panBy(spanMs / 10);
      else if (event.key === "+" || event.key === "=") zoomAbout(1, 0.8);
      else if (event.key === "-") zoomAbout(1, 1.25);
      else if (event.key === "End") api.backToNow();
      else return;
      event.preventDefault();
    },
    listen,
  );
  const resized = new ResizeObserver(() => schedule());
  resized.observe(canvas);

  const api = {
    /** The stretch of time to ask the worker for. */
    window(): TimelineWindow {
      // A waiting Show last choice asks for the stretch it is about to show.
      const span = pending?.spanMs ?? spanMs;
      const to = pending ? clock() : right();
      // A little past each edge, so a small move has something to show before the next answer arrives.
      return { from: to - span * 1.25, to: to + span * 0.25, points: Math.round(plotWidth() / 2) * 1.5 };
    },
    /** The ping time, which sets how far in the view can zoom. */
    setPingTime(ms: number) {
      if (ms === pingMs) return;
      pingMs = ms;
      if (spanMs < minSpan()) {
        spanMs = minSpan();
        changed();
      }
    },
    following: () => end === null,
    /** The saved scale: the answer time at the top, or null for Auto. */
    setScale(ms: number | null) {
      if (ms === scaleMs) return;
      scaleMs = ms;
      schedule();
    },
    spanMs: () => spanMs,
    /**
     * New results to draw. `forWindow` says they answer the newest window(), which is what lets a
     * waiting Show last choice take effect together with them.
     */
    setData(next: Series | undefined, nextLimit: number | null, forWindow = false) {
      series = next;
      limit = nextLimit;
      if (forWindow) commit();
      schedule();
    },
    /** Shows the last `ms` up to the present, once its results arrive or after half a second. */
    showLast(ms: number, now = false) {
      if (pending) clearTimeout(pending.timer);
      pending = { spanMs: clamp(ms, minSpan(), MAX_SPAN_MS), timer: setTimeout(commit, 500) };
      if (now) commit();
      options.onHover(null);
      options.onWindow();
    },
    backToNow() {
      if (end === null) return;
      end = null;
      options.onFollow(true);
      changed();
    },
    /** Called as time passes, so a view that follows the present keeps moving. */
    tick: () => {
      if (end === null) schedule();
    },
    dispose() {
      if (pending) clearTimeout(pending.timer);
      controller.abort();
      resized.disconnect();
      cancelAnimationFrame(frame);
    },
  };
  return api;
}
