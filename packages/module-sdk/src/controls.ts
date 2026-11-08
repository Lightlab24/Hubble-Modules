/**
 * Hubble's shared controls for a package-owned custom page. API feature v1.
 * Hubble owns presentation and interaction. The module owns validation, command
 * queues and device readback. There is no rotary knob.
 */
import type { ModuleTimecodeFrameRate } from "./timecode.js";

export const MODULE_CONTROLS_FEATURE = "module-controls-v1";

/** What the device last confirmed, and whether a command is on its way. Shared by inputs. */
export interface ControlFeedback<T> {
  /** The device's last reported value. Shown beside the control; it never moves it. */
  readonly confirmedValue?: T | null | undefined;
  /** A command for the current value is queued or in flight. */
  readonly pending?: boolean | undefined;
  /** Validation or unconfirmed-feedback text. The current value stays as it is. */
  readonly error?: string | null | undefined;
  /** Use only for real access, availability, dependency or firmware restrictions. */
  readonly disabled?: boolean | undefined;
}

interface MountBase<S> {
  /** An empty, module-owned element. The control renders inside it until dispose(). */
  readonly root: HTMLElement;
  readonly label: string;
  /** Added to the control's root element, for example to scope CSS tokens. */
  readonly className?: string | undefined;
  getState(): S;
  onError?(error: Error): void;
}

export interface MountedControl {
  /** Re-read getState(), for example after a device readback. */
  refresh(): void;
  dispose(): void;
}

export interface SwitchState extends ControlFeedback<boolean> {
  readonly checked: boolean;
  readonly onLabel?: string | undefined;
  readonly offLabel?: string | undefined;
}
export interface SwitchOptions extends MountBase<SwitchState> {
  /** Fires once per flip. Update the value getState() returns immediately. */
  onCheckedChange(checked: boolean): void;
}

export interface SegmentedOption {
  readonly value: string;
  readonly label: string;
}
export interface SegmentedState extends ControlFeedback<string> {
  readonly value: string;
  /** Two to eight options, in display order. */
  readonly options: readonly SegmentedOption[];
}
export interface SegmentedOptions extends MountBase<SegmentedState> {
  onValueChange(value: string): void;
}

export interface StepperState extends ControlFeedback<number> {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string | undefined;
}
export interface StepperOptions extends MountBase<StepperState> {
  /** Fires once per button press, arrow key or typed entry. */
  onValueChange(value: number): void;
}

export interface TimecodeState extends ControlFeedback<string> {
  readonly value: string;
  readonly frameRate: ModuleTimecodeFrameRate;
  /** An optional field may be cleared to an empty string. */
  readonly required?: boolean | undefined;
}
export interface TimecodeOptions extends MountBase<TimecodeState> {
  /** Fires on Enter or leaving the field, only with valid timecode. */
  onValueChange(value: string): void;
}

export type ButtonTone = "neutral" | "program" | "preview" | "healthy";
export interface ButtonState {
  /** Latching buttons: whether the button is held on. Ignored for other modes. */
  readonly pressed?: boolean | undefined;
  /** Latching buttons: the device's last reported state. */
  readonly confirmedPressed?: boolean | null | undefined;
  readonly pending?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  /** A second line under the label, such as "hold". */
  readonly detail?: string | undefined;
  readonly tone?: ButtonTone | undefined;
}
export interface ButtonOptions extends MountBase<ButtonState> {
  /** trigger: one press. momentary: press and release. latching: on and off. */
  readonly mode: "trigger" | "momentary" | "latching";
  /** trigger and momentary: pointer or key down. latching: the new held state. */
  onPress(pressed: boolean): void;
  /** momentary only: pointer or key up, or the pointer leaving while held. */
  onRelease?(): void;
}

export type LampTone = "red" | "green" | "amber" | "blue" | "off";
export interface LampState {
  /** The published state key. null, or a key missing from states, shows as unknown. */
  readonly value: string | null;
  readonly states: Readonly<
    Record<
      string,
      { readonly tone: LampTone; readonly label?: string | undefined }
    >
  >;
}
export type LampOptions = MountBase<LampState>;

export type MeterTone = "warning" | "failure";
export interface MeterState {
  /** null shows as unknown. */
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly unit?: string | undefined;
  /** A held peak marker, in the same units. */
  readonly peak?: number | null | undefined;
  /** Zones start at from and run to the next zone or max. */
  readonly zones?:
    readonly { readonly from: number; readonly tone: MeterTone }[] | undefined;
}
export interface MeterOptions extends MountBase<MeterState> {
  readonly orientation?: "horizontal" | "vertical" | undefined;
}

export interface XYValue {
  readonly x: number;
  readonly y: number;
}
export interface XYPadState extends ControlFeedback<XYValue> {
  readonly value: XYValue;
  readonly x: {
    readonly min: number;
    readonly max: number;
    readonly label?: string | undefined;
  };
  readonly y: {
    readonly min: number;
    readonly max: number;
    readonly label?: string | undefined;
  };
  readonly unit?: string | undefined;
}
export interface XYPadOptions extends MountBase<XYPadState> {
  /** Fires for every step of a gesture. Update the value getState() returns immediately. */
  onValueChange(value: XYValue): void;
  /** Fires once per gesture, on release or key press. Queue the device command here. */
  onValueCommit(value: XYValue): void;
}

export interface ChoicePickerChoice {
  readonly value: string;
  readonly label: string;
  readonly group?: string;
}
export type ChoicePickerProvider =
  | readonly ChoicePickerChoice[]
  | ((
      query: string,
      signal: AbortSignal,
    ) =>
      readonly ChoicePickerChoice[] | Promise<readonly ChoicePickerChoice[]>);
export interface ChoicePickerState extends ControlFeedback<string> {
  readonly value: string;
  /** Shown on the button when the value is not among the loaded choices. */
  readonly valueLabel?: string | undefined;
}
export interface ChoicePickerOptions extends MountBase<ChoicePickerState> {
  /** Keep the identity stable during unrelated feedback; replace it and refresh() to reload. */
  readonly choices: ChoicePickerProvider;
  onValueChange(value: string): void;
}

export interface ColorPickerState extends ControlFeedback<string> {
  /** A #RRGGBB colour. */
  readonly value: string;
}
export interface ColorPickerOptions extends MountBase<ColorPickerState> {
  /** Save favourites in module-owned preferences. Without it they last for this page. */
  readonly favorites?: {
    get(): readonly string[];
    set(colors: readonly string[]): void;
  };
  onValueChange(value: string): void;
}

export interface ToastOptions {
  readonly kind?: "success" | "failure" | undefined;
  readonly title: string;
  readonly message?: string | undefined;
}
export interface ConfirmOptions {
  readonly title: string;
  readonly message?: string | undefined;
  readonly confirmLabel?: string | undefined;
  readonly cancelLabel?: string | undefined;
  /** Shows the confirm button in the destructive style. */
  readonly danger?: boolean | undefined;
}

type Runtime = {
  mountSwitch(options: SwitchOptions): MountedControl;
  mountSegmented(options: SegmentedOptions): MountedControl;
  mountStepper(options: StepperOptions): MountedControl;
  mountTimecode(options: TimecodeOptions): MountedControl;
  mountButton(options: ButtonOptions): MountedControl;
  mountLamp(options: LampOptions): MountedControl;
  mountMeter(options: MeterOptions): MountedControl;
  mountXYPad(options: XYPadOptions): MountedControl;
  mountChoicePicker(options: ChoicePickerOptions): MountedControl;
  mountColorPicker(options: ColorPickerOptions): MountedControl;
  showToast(options: ToastOptions): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
};
let runtime: Promise<Runtime> | undefined;

/** Loads the host's control runtime once. Rejects outside a custom page or on an older host. */
function loadRuntime(): Promise<Runtime> {
  if (
    window.parent === window ||
    !/^\/api\/module-pages\/[A-Za-z0-9_-]{43}\/ui\//u.test(location.pathname)
  )
    return Promise.reject(
      new Error("Hubble controls require a Hubble custom page"),
    );
  runtime ??= (async () => {
    const url = new URL("/api/module-controls/controls-v1.js", location.href)
      .href;
    let loaded: Partial<Runtime>;
    try {
      loaded = (await import(/* @vite-ignore */ url)) as Partial<Runtime>;
    } catch (cause) {
      throw new Error(`Host does not supply ${MODULE_CONTROLS_FEATURE}`, {
        cause,
      });
    }
    if (typeof loaded.mountSwitch !== "function")
      throw new Error(`Host does not supply ${MODULE_CONTROLS_FEATURE}`);
    return loaded as Runtime;
  })();
  // A failed load can be retried, for example after the host is updated.
  runtime.catch(() => {
    runtime = undefined;
  });
  return runtime;
}

/** The module page's On/Off switch. One onCheckedChange per flip. */
export async function mountSwitch(
  options: SwitchOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountSwitch(options);
}
/** A choice drawn as 2 to 8 buttons. */
export async function mountSegmented(
  options: SegmentedOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountSegmented(options);
}
/** − and + around a typed number. One onValueChange per press or entry. */
export async function mountStepper(
  options: StepperOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountStepper(options);
}
/** HH:MM:SS:FF entry, checked against the frame rate before it reports. */
export async function mountTimecode(
  options: TimecodeOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountTimecode(options);
}
/** A trigger, momentary or latching control-surface button. */
export async function mountButton(
  options: ButtonOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountButton(options);
}
/** A read-only tally lamp. A missing or unmapped value shows as unknown, never off. */
export async function mountLamp(options: LampOptions): Promise<MountedControl> {
  return (await loadRuntime()).mountLamp(options);
}
/** A read-only level or progress bar with optional warning and failure zones. */
export async function mountMeter(
  options: MeterOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountMeter(options);
}
/** A two-axis pad, such as pan and tilt. One onValueCommit per gesture. */
export async function mountXYPad(
  options: XYPadOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountXYPad(options);
}
/** The Matrix choice editor, with groups and search, opened from its own button. */
export async function mountChoicePicker(
  options: ChoicePickerOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountChoicePicker(options);
}
/** The Matrix colour editor with favourites, opened from its own swatch. */
export async function mountColorPicker(
  options: ColorPickerOptions,
): Promise<MountedControl> {
  return (await loadRuntime()).mountColorPicker(options);
}
/** Hubble's fading toast, shown inside the page. */
export async function showToast(options: ToastOptions): Promise<void> {
  (await loadRuntime()).showToast(options);
}
/** Asks before a destructive command. Resolves true only from the confirm button. */
export async function confirm(options: ConfirmOptions): Promise<boolean> {
  return (await loadRuntime()).confirm(options);
}
