import {
  confirm,
  mountButton,
  mountChoicePicker,
  mountColorPicker,
  mountLamp,
  mountMeter,
  mountSegmented,
  mountStepper,
  mountSwitch,
  mountTimecode,
  mountXYPad,
  showToast,
  type ChoicePickerChoice,
  type MountedControl,
  type XYValue,
} from "@hubble/module-sdk/controls";
import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import { createLatestValueQueue } from "./latest-value-queue.js";
import "./frontend.css";

const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), { once: true });
const page = await connectModuleFrontend(window, lifetime.signal);
type Values = Record<string, unknown>;
const valuesOf = (state: Awaited<ReturnType<typeof page.state>>): Values =>
  (state?.values ?? {}) as Values;

// Read the device first, so a reopened page never shows a stale value.
let device = valuesOf(await page.state());
const controls: MountedControl[] = [];
const refresh = () => {
  for (const control of controls) control.refresh();
};
const slot = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

/**
 * One live value: the local value leads and the device's value is tracked apart from
 * it, so a late readback never pulls a control back behind a newer edit.
 */
function live<T>(control: string, read: (values: Values) => T | null) {
  const value = {
    local: read(device),
    confirmed: read(device),
    edited: false,
    error: null as string | null,
    queue: createLatestValueQueue<T>({
      send: (next) => page.call("set", { control, value: next }),
      onSettled(result) {
        // A failure of an older value says nothing about the newest one still on its way.
        if (result.newest) value.error = result.error?.message ?? null;
        refresh();
      },
    }),
    set(next: T) {
      value.local = next;
      value.edited = true;
      value.error = null;
      value.queue.push(next);
    },
    feedback() {
      return {
        confirmedValue: value.confirmed,
        pending: value.queue.pending,
        error: value.error,
      };
    },
    observe(values: Values) {
      value.confirmed = read(values);
      // Until the operator edits, the device's value is the only one there is.
      if (!value.edited) value.local = value.confirmed;
    },
  };
  return value;
}
const bool = (key: string) => (values: Values) =>
  typeof values[key] === "boolean" ? (values[key] as boolean) : null;
const text = (key: string) => (values: Values) =>
  typeof values[key] === "string" ? (values[key] as string) : null;
const number = (key: string) => (values: Values) =>
  typeof values[key] === "number" ? (values[key] as number) : null;

const record = live("record", bool("record"));
const ftb = live("ftb", bool("ftb"));
const bus = live("bus", text("bus"));
const preset = live("preset", number("preset"));
const cue = live("cue", text("cue"));
const source = live("source", text("source"));
const color = live("color", text("color"));
const ptz = live<XYValue>("ptz", (values) => {
  const point = values.ptz as XYValue | undefined;
  return point && typeof point.x === "number" ? point : null;
});
const values = [record, ftb, bus, preset, cue, source, color, ptz];
const sourceLabels = new Map(
  (
    (await page.call("sources", "")) as { sources: ChoicePickerChoice[] }
  ).sources.map((choice) => [choice.value, choice.label]),
);
let takePending = false;

controls.push(
  await mountSwitch({
    root: slot("record"),
    label: "Record",
    getState: () => ({ checked: record.local ?? false, ...record.feedback() }),
    onCheckedChange: (checked) => record.set(checked),
  }),
  await mountSegmented({
    root: slot("bus"),
    label: "Bus",
    getState: () => ({
      value: bus.local ?? "pgm",
      options: [
        { value: "pgm", label: "Program" },
        { value: "pvw", label: "Preview" },
        { value: "off", label: "Off" },
      ],
      ...bus.feedback(),
    }),
    onValueChange: (value) => bus.set(value),
  }),
  await mountStepper({
    root: slot("preset"),
    label: "Preset",
    getState: () => ({
      value: preset.local ?? 1,
      min: 1,
      max: 99,
      step: 1,
      ...preset.feedback(),
    }),
    onValueChange: (value) => preset.set(value),
  }),
  await mountTimecode({
    root: slot("cue"),
    label: "Cue",
    getState: () => ({
      value: cue.local ?? "",
      frameRate: "25",
      required: true,
      ...cue.feedback(),
    }),
    onValueChange: (value) => cue.set(value),
  }),
  await mountChoicePicker({
    root: slot("source"),
    label: "Source",
    // A live provider: the backend filters, and stale queries are aborted by Hubble.
    async choices(query, signal) {
      const result = (await page.call("sources", query)) as {
        sources: ChoicePickerChoice[];
      };
      signal.throwIfAborted();
      for (const choice of result.sources)
        sourceLabels.set(choice.value, choice.label);
      return result.sources;
    },
    getState: () => ({
      value: source.local ?? "",
      // Shown on the button before the operator has searched.
      valueLabel: sourceLabels.get(source.local ?? ""),
      ...source.feedback(),
    }),
    onValueChange: (value) => source.set(value),
  }),
  await mountColorPicker({
    root: slot("color"),
    label: "Button colour",
    getState: () => ({ value: color.local ?? "#0090ff", ...color.feedback() }),
    onValueChange: (value) => color.set(value),
  }),
  await mountButton({
    root: slot("take"),
    label: "TAKE",
    mode: "momentary",
    getState: () => ({ detail: "hold", tone: "program", pending: takePending }),
    onPress() {
      takePending = true;
      void page.call("press", { button: "take", down: true });
    },
    onRelease() {
      void page.call("press", { button: "take", down: false }).finally(() => {
        takePending = false;
        refresh();
      });
    },
  }),
  await mountButton({
    root: slot("ftb"),
    label: "FTB",
    mode: "latching",
    getState: () => ({
      pressed: ftb.local ?? false,
      confirmedPressed: ftb.confirmed,
      pending: ftb.queue.pending,
      error: ftb.error,
      tone: "healthy",
    }),
    onPress: (pressed) => ftb.set(pressed),
  }),
  await mountButton({
    root: slot("clear"),
    label: "Clear routes",
    mode: "trigger",
    getState: () => ({}),
    async onPress() {
      const routes = typeof device.routes === "number" ? device.routes : 0;
      // Nothing is sent unless the operator presses the confirm button.
      if (
        !(await confirm({
          title: "Clear all routes?",
          message: `This sends ${routes} commands to the router.`,
          confirmLabel: "Clear routes",
          danger: true,
        }))
      )
        return;
      try {
        await page.call("clear-routes", null);
        await showToast({
          title: "Routes cleared",
          message: `${routes} commands sent.`,
        });
      } catch (error) {
        await showToast({
          kind: "failure",
          title: "Routes not cleared",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  }),
  await mountXYPad({
    root: slot("ptz"),
    label: "Pan / tilt",
    getState: () => ({
      value: ptz.local ?? { x: 0, y: 0 },
      x: { min: -170, max: 170, label: "Pan" },
      y: { min: -30, max: 90, label: "Tilt" },
      unit: "°",
      ...ptz.feedback(),
    }),
    onValueChange(value) {
      ptz.local = value;
    },
    onValueCommit: (value) => ptz.set(value),
  }),
  await mountLamp({
    root: slot("lamp"),
    label: "CAM 1",
    getState: () => ({
      value: text("cam1")(device),
      states: {
        program: { tone: "red", label: "Program" },
        preview: { tone: "green", label: "Preview" },
        off: { tone: "off", label: "Off" },
      },
    }),
  }),
  await mountMeter({
    root: slot("meter"),
    label: "Audio L",
    getState: () => ({
      value: number("audioL")(device),
      min: -60,
      max: 0,
      unit: " dB",
      zones: [
        { from: -20, tone: "warning" },
        { from: -6, tone: "failure" },
      ],
    }),
  }),
);

const stop = page.subscribe((state) => {
  device = valuesOf(state);
  for (const value of values) value.observe(device);
  refresh();
});
lifetime.signal.addEventListener(
  "abort",
  () => {
    stop();
    for (const control of controls) control.dispose();
    page.dispose();
  },
  { once: true },
);
