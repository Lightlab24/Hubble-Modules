/** Hubble's shared slider for a package-owned layout. API feature v1. */
export const MODULE_SLIDERS_FEATURE = "module-sliders-v1";

export interface SliderTheme {
  readonly fill?: string;
  readonly thumb?: string;
  readonly track?: string;
  readonly focus?: string;
  readonly value?: string;
  readonly error?: string;
}
export interface SliderState {
  readonly value: number;
  /** A device may advertise a new range or step; the control follows on refresh(). */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Printed directly after the value, so include any space: "%" or " dB". */
  readonly unit?: string | undefined;
  /** Use only for real access, availability, dependency or firmware restrictions. */
  readonly disabled?: boolean;
  /** The last value the device reported. Shown beside the value; it never moves the thumb. */
  readonly confirmedValue?: number | null | undefined;
  /** A command for the current value is queued or in flight. */
  readonly pending?: boolean;
  /** Validation or unconfirmed-feedback text. The current value stays as it is. */
  readonly error?: string | null | undefined;
}
export interface SliderControlsOptions {
  /** An empty, module-owned element. The control renders inside it until dispose(). */
  readonly root: HTMLElement;
  readonly label: string;
  readonly layout?: "inspector" | "cell";
  /** Added to the control's root element, for example to scope CSS tokens. */
  readonly className?: string;
  /** Inline overrides. A value here beats the same token set in module CSS. */
  readonly theme?: SliderTheme;
  getState(): SliderState;
  /** Fires for every step of a gesture. Update the value getState() returns immediately. */
  onValueChange(value: number): void;
  /** Fires once per gesture, on release or key press. Queue the device command here. */
  onValueCommit(value: number): void;
  onError?(error: Error): void;
}
export interface SliderControls {
  /** Re-read getState(), for example after a device readback. */
  refresh(): void;
  dispose(): void;
}

/** Mount the host's slider. Rejects on an older host or an invalid first state. */
export async function mountSlider(
  options: SliderControlsOptions,
): Promise<SliderControls> {
  if (
    window.parent === window ||
    !/^\/api\/module-pages\/[A-Za-z0-9_-]{43}\/ui\//u.test(location.pathname)
  ) {
    throw new Error("Sliders require a Hubble custom page");
  }
  const url = new URL("/api/module-controls/slider-v1.js", location.href).href;
  let runtime: {
    mount?: (input: SliderControlsOptions) => SliderControls;
  };
  try {
    runtime = await import(/* @vite-ignore */ url);
  } catch (cause) {
    throw new Error(`Host does not supply ${MODULE_SLIDERS_FEATURE}`, {
      cause,
    });
  }
  if (typeof runtime.mount !== "function") {
    throw new Error(`Host does not supply ${MODULE_SLIDERS_FEATURE}`);
  }
  return runtime.mount(options);
}
