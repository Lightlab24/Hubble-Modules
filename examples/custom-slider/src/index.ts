import type { HubbleModule } from "@hubble/module-sdk";

/** Stands in for a device-advertised range. Keep the check in module code. */
export const ZOOM_RANGE = { min: 10, max: 200, step: 0.1 };

function requestedZoom(value: unknown): number {
  const zoom =
    value && typeof value === "object" && "zoom" in value ? value.zoom : null;
  if (
    typeof zoom !== "number" ||
    zoom < ZOOM_RANGE.min ||
    zoom > ZOOM_RANGE.max
  )
    throw new Error(`Zoom must be ${ZOOM_RANGE.min}–${ZOOM_RANGE.max}%`);
  return zoom;
}

export default {
  createInstance(context) {
    let zoom = 100;
    let disposed = false;
    const publish = () => {
      context.publishState({
        phase: "ready",
        message: null,
        observedAt: new Date().toISOString(),
        values: { zoom },
      });
    };
    return {
      start: publish,
      call(method, request, execution) {
        execution.signal.throwIfAborted();
        if (disposed) throw new Error("Instance disposed");
        if (
          method !== "page.zoom" ||
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          request.commandId !== "set-zoom"
        )
          throw new Error("Unknown page command");
        zoom = requestedZoom(request.value);
        // A real module reports what the device confirms, not what it was asked for.
        publish();
        return { zoom };
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
