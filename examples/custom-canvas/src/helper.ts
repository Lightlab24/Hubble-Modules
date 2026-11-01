import { serveModuleHelper } from "@hubble/module-sdk/helper-runtime";
import { renderLabel } from "./render-label.js";

// The package owns rendering. Native dependencies can be packaged beside this entry.
serveModuleHelper({
  methods: {
    render: async (value, signal) => {
      signal.throwIfAborted();
      return renderLabel(value);
    },
  },
});
