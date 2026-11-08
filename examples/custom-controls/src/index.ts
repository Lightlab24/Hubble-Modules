import type { HubbleModule } from "@hubble/module-sdk";
import {
  applyControl,
  applyPress,
  filterSources,
  initialDevice,
  type DeviceState,
} from "./device.js";

/** A reply delay like a real device's, so a second edit can arrive while one is held. */
export const REPLY_MS = 400;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export default {
  createInstance(context) {
    let device: DeviceState = initialDevice();
    let disposed = false;
    const tallyOn = context.settings.tallyOutput !== false;
    const publish = () => {
      context.publishState({
        phase: "ready",
        message: null,
        observedAt: new Date().toISOString(),
        values: {
          ...device,
          // Status lamps and meters on the settings page. cam4 is never published.
          cam1: tallyOn ? (device.take ? "program" : "preview") : "off",
          cam2: tallyOn ? (device.bus === "pvw" ? "preview" : "off") : "off",
          cam3: "off",
          audioL: device.record ? -9 : -18,
          audioR: device.record ? -4 : -21,
        },
      });
    };
    return {
      start: publish,
      async call(method, request, execution) {
        execution.signal.throwIfAborted();
        if (disposed) throw new Error("Instance disposed");
        if (
          method !== "page.controls" ||
          !request ||
          typeof request !== "object" ||
          Array.isArray(request)
        )
          throw new Error("Unknown page command");
        const { commandId, value } = request as {
          commandId?: unknown;
          value?: unknown;
        };
        if (commandId === "sources") return { sources: filterSources(value) };
        await wait(REPLY_MS, execution.signal);
        if (commandId === "set") device = applyControl(device, value);
        else if (commandId === "press") device = applyPress(device, value);
        else if (commandId === "clear-routes")
          device = { ...device, routes: 0 };
        else throw new Error("Unknown page command");
        publish();
        return { ok: true };
      },
      async execute() {
        throw new Error("No actions declared");
      },
      dispose() {
        disposed = true;
      },
    };
  },
} satisfies HubbleModule;
