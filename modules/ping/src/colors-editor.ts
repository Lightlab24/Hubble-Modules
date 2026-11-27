import { BAND_STEPS, PING_COLORS, type Bands, type BandStep } from "./model.js";

/**
 * The Colors panel under the timeline: green, yellow and orange, each with the time in ms it
 * covers answers up to, then red for anything over the last one. An empty time leaves that colour
 * out. Every change saves at once; Follow alert limit goes back to the colours that follow the
 * alert setting.
 */
export interface ColorsEditorOptions {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  /** The user's times, or undefined while the colours follow the alert limit. */
  get(): Bands | undefined;
  /** Saves the user's times; null follows the alert limit again. */
  set(bands: Bands | null): void;
  onError(message: string): void;
}

const NAMES: Record<BandStep | "red", string> = { green: "Green", yellow: "Yellow", orange: "Orange", red: "Red" };
const label = (ms: number) => `${Number(ms.toPrecision(4))} ms`;

export function createColorsEditor(options: ColorsEditorOptions) {
  const { button, panel } = options;
  const rows = panel.querySelector<HTMLElement>(".color-rows")!;
  const inputs = new Map<BandStep, HTMLInputElement>();
  /** Times typed that couldn't be used. They stay as typed, marked, until fixed or the panel closes. */
  const wrong = new Set<BandStep>();

  const line = (color: string, name: string, ...rest: Node[]) => {
    const row = document.createElement("div");
    row.className = "color-row";
    const dot = document.createElement("i");
    dot.style.background = color;
    const text = document.createElement("span");
    text.className = "color-name";
    text.textContent = name;
    row.append(dot, text, ...rest);
    rows.append(row);
    return row;
  };
  for (const step of BAND_STEPS) {
    const upTo = document.createElement("span");
    upTo.textContent = "up to";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0.1";
    input.max = "60000";
    input.step = "any";
    input.inputMode = "decimal";
    input.className = "band-ms";
    input.dataset.step = step;
    input.placeholder = "—";
    input.setAttribute("aria-label", `${NAMES[step]} up to, in ms`);
    input.addEventListener("change", () => setTime(step, input));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
    const unit = document.createElement("span");
    unit.textContent = "ms";
    inputs.set(step, input);
    line(PING_COLORS[step], NAMES[step], upTo, input, unit);
  }
  const overText = document.createElement("span");
  overText.className = "over-label";
  line(PING_COLORS.red, NAMES.red, overText);

  /** Writes the saved times, never over a number being typed. */
  function refresh() {
    const bands = options.get();
    for (const [step, input] of inputs) {
      if (document.activeElement === input || wrong.has(step)) continue;
      const value = bands?.[step] ?? null;
      const text = value === null ? "" : String(value);
      if (input.value !== text) input.value = text;
    }
    const last = bands ? [...BAND_STEPS].reverse().map((step) => bands[step]).find((value) => value !== null) : undefined;
    overText.textContent = last ? `over ${label(last)}` : "over the last time";
    panel.querySelector<HTMLButtonElement>(".follow-alert")!.hidden = !bands;
    panel.querySelector<HTMLElement>(".colors-note")!.hidden = !!bands;
  }

  function setTime(step: BandStep, input: HTMLInputElement) {
    const typed = input.value.trim();
    const value = typed === "" ? null : Number(typed);
    const next: Bands = { green: null, yellow: null, orange: null, ...options.get(), [step]: value };
    let problem = "";
    if (value !== null && (!Number.isFinite(value) || value < 0.1 || value > 60_000)) problem = "Use a time from 0.1 to 60000 ms.";
    else {
      // Each colour has to start where the one before it ends.
      const index = BAND_STEPS.indexOf(step);
      const below = BAND_STEPS.slice(0, index).map((other) => [other, next[other]] as const).filter(([, ms]) => ms !== null).at(-1);
      const above = BAND_STEPS.slice(index + 1).map((other) => [other, next[other]] as const).find(([, ms]) => ms !== null);
      if (value !== null && below && value <= below[1]!) problem = `${NAMES[step]} has to be above ${NAMES[below[0]].toLowerCase()} (${label(below[1]!)}).`;
      else if (value !== null && above && value >= above[1]!) problem = `${NAMES[step]} has to be below ${NAMES[above[0]].toLowerCase()} (${label(above[1]!)}).`;
    }
    if (problem) {
      // The field keeps what was typed and shows it is wrong; the saved times stay as they were.
      wrong.add(step);
      input.setAttribute("aria-invalid", "true");
      options.onError(problem);
      return;
    }
    wrong.delete(step);
    input.removeAttribute("aria-invalid");
    // Emptying every time goes back to following the alert limit.
    options.set(BAND_STEPS.some((other) => next[other] !== null) ? next : null);
  }

  panel.querySelector(".follow-alert")!.addEventListener("click", () => options.set(null));

  /**
   * Opens just above the Colors button, 9 px clear of it, on whichever line of the row under the
   * timeline a narrow window has put it. In a wide window that is where the stylesheet puts it.
   */
  function place() {
    const area = panel.offsetParent;
    if (!(area instanceof HTMLElement)) return;
    panel.style.bottom = `${Math.round(area.getBoundingClientRect().bottom - button.getBoundingClientRect().top + 9)}px`;
  }
  window.addEventListener("resize", () => {
    if (!panel.hidden) place();
  });

  function open() {
    panel.hidden = false;
    place();
    button.setAttribute("aria-expanded", "true");
    refresh();
    inputs.get("green")!.focus();
  }
  function close() {
    if (panel.hidden) return;
    // A wrong time that was never fixed goes back to the saved one.
    for (const step of wrong) inputs.get(step)!.removeAttribute("aria-invalid");
    wrong.clear();
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
  button.addEventListener("click", () => (panel.hidden ? open() : close()));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    if (!panel.hidden && !panel.contains(target) && !button.contains(target)) close();
  });

  return {
    /** Shows the times as they are now. */
    refresh() {
      if (!panel.hidden) refresh();
    },
    close,
  };
}
