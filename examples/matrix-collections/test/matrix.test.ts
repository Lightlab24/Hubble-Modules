import { expect, it } from "vitest";
import { createModuleHarness } from "@hubble/module-sdk/testing";
import { formatModuleColorPalette } from "@hubble/module-sdk";
import module from "../src/index.js";

it.each([true, false])(
  "publishes ordered choices and preserves palette positions with connectionEnabled=%s",
  async (connectionEnabled) => {
    const harness = createModuleHarness(
      module,
      { offset: null },
      { connectionEnabled },
    );
    await harness.instance.start();
    const query = {
      version: 2 as const,
      provider: "presets",
      draft: {},
      search: "",
      cursor: null,
      limit: 1,
      requestRevision: 1,
    };
    const first = await harness.instance.discoverChoices!(query, {
      signal: new AbortController().signal,
    });
    const second = await harness.instance.discoverChoices!(
      { ...query, cursor: first.nextCursor },
      { signal: new AbortController().signal },
    );
    expect(second.choices[0]).toMatchObject({
      id: "reverse",
      values: { "module.cues": "2, 1" },
    });
    const fields = {
      values: {
        actionType: "reverse",
        "module.cues": "2, 1",
        "module.colors": formatModuleColorPalette("#ABCDEF", [
          "#112233",
          "#445566",
          "#778899",
          "#AABBCC",
        ]),
      },
    };
    expect(
      await harness.instance.execute("apply", fields, harness.execution()),
    ).toMatchObject({ status: "success" });
    expect(harness.states.at(-1)).toMatchObject({
      values: { cues: [2, 1], offset: null },
    });
    await harness.instance.subscribeFeedback!([{ id: "selected", fields }], {
      signal: new AbortController().signal,
    });
    expect(harness.feedback.at(-1)).toMatchObject({
      appearance: { backgroundColor: "#112233" },
    });
    fields.values["module.cues"] = "2";
    await harness.instance.subscribeFeedback!([{ id: "selected", fields }], {
      signal: new AbortController().signal,
    });
    expect(harness.feedback.at(-1)).toMatchObject({
      appearance: { backgroundColor: "#ABCDEF" },
    });
    fields.values["module.cues"] = "2, 2";
    expect(
      await harness.instance.execute("apply", fields, harness.execution()),
    ).toMatchObject({ status: "failure" });
    await harness.instance.dispose();
  },
);
