import type { HubbleModule } from "@hubble/module-sdk";
import { Capture } from "./capture.js";

const module: HubbleModule = {
  createInstance(context) {
    const capture = new Capture(context);
    return {
      async start() {
        capture.start();
      },
      async execute() {
        return {
          status: "failure",
          category: "invalid-config",
          message: "MQTT Capture is available only from its sidebar page",
        };
      },
      async call(method, value, execution) {
        if (execution.signal.aborted) throw new Error("Page command cancelled");
        if (
          method !== "page.capture" ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value)
        )
          throw new Error("Unknown page command");
        const request = value as {
          sectionId?: string;
          commandId?: string;
          fields?: Record<string, unknown>;
          cursor?: unknown;
        };
        if (request.sectionId !== "captureControls")
          throw new Error("Unknown page control");
        const fields = request.fields ?? {};
        switch (request.commandId) {
          case "start":
            return { ...capture.begin(fields.host, fields.port) };
          case "stop":
            return { ...capture.stop() };
          case "marker":
            return { ...capture.marker(fields.note) };
          case "copy":
          case "export":
            return { ...capture.text(request.cursor) };
          default:
            throw new Error("Unknown page command");
        }
      },
      async dispose() {
        capture.dispose();
      },
    };
  },
};
export default module;
