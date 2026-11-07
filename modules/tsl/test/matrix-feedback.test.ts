import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ModuleContext,
  ModuleFeedback,
  ModuleFeedbackSubscription,
} from "@hubble/module-sdk";
import { MatrixFeedback } from "../src/matrix-feedback.js";
import type { TslReceiver } from "../src/receiver.js";

const column = randomUUID(),
  otherColumn = randomUUID();
const settings = {
  indicationEnabled: true,
  programFlag: 2,
  redFields: ["text"],
  cycleMs: 2000,
};
function request(
  actionType: string,
  actionColumnId = column,
): ModuleFeedbackSubscription {
  return {
    id: "matrix",
    fields: {
      actionId: actionColumnId,
      actionColumnId,
      settings,
      values: {
        enabled: true,
        actionType,
        tallyAddress: 1,
        tallyScreen: 0,
        glowCycleMs: 0,
      },
    },
  };
}
function harness(
  runtimeDirectory?: string,
  modules?: ModuleContext["modules"],
) {
  let fresh = true,
    active = true,
    protocol = "3.1";
  const values: ModuleFeedback[] = [];
  const receiver = {
    health: () => ({ phase: "listening" }),
    resolve: () => ({
      protocol,
      left: 1,
      text: 0,
      right: 2,
      fresh,
      flags: [false, active, false, false],
      label: "Camera 1",
    }),
  } as unknown as TslReceiver;
  const host = vi.fn();
  const context = {
    runtimeDirectory,
    modules,
    settings: {},
    publishFeedback: (value: ModuleFeedback) => values.push(value),
    requestHost: host,
  } as unknown as ModuleContext;
  return {
    instance: new MatrixFeedback(context, () => receiver),
    values,
    host,
    set: (state: { fresh?: boolean; active?: boolean; protocol?: string }) => {
      protocol = state.protocol ?? protocol;
      fresh = state.fresh ?? fresh;
      active = state.active ?? active;
    },
  };
}
describe("module-owned Matrix Tally feedback", () => {
  it("preserves plain-source glow and explicit row colours without host control calls", async () => {
    const h = harness();
    await h.instance.start();
    try {
      h.instance.subscribe([request("tally-feedback")]);
      expect(h.values.at(-1)).toMatchObject({
        state: "active",
        appearance: {
          backgroundColor: null,
          glow: { color: "#FF0000", cycleMs: 2000 },
        },
      });
      h.instance.subscribe([
        request("tally-feedback;feedback=on;colors=#13579B|#2468AC;glow=off"),
      ]);
      expect(h.values.at(-1)).toMatchObject({
        state: "active",
        appearance: { backgroundColor: "#13579B", glow: null },
      });
      h.set({ active: false });
      h.instance.emit();
      expect(h.values.at(-1)).toMatchObject({
        state: "inactive",
        appearance: { backgroundColor: "#2468AC", glow: null },
      });
      h.set({ fresh: false });
      h.instance.emit();
      expect(h.values.at(-1)).toMatchObject({
        state: "unavailable",
        appearance: { backgroundColor: null, glow: null },
      });
      expect(h.host).not.toHaveBeenCalled();
    } finally {
      await h.instance.close();
    }
  });
  it("uses protocol-specific flags and selected red fields with independent row cycle overrides", async () => {
    const h = harness();
    const base = request(
      "tally-feedback;feedback=on;colors=#13579B|#2468AC;glow=on",
    );
    const configured = (
      redFields: string[],
      cycle: number,
      programFlag = 2,
    ) => ({
      ...base,
      fields: {
        ...base.fields,
        settings: { ...settings, redFields, programFlag, cycleMs: 1700 },
        values: { ...(base.fields.values as object), glowCycleMs: cycle },
      },
    });
    await h.instance.start();
    try {
      h.instance.subscribe([configured(["text"], 900)]);
      expect(h.values.at(-1)).toMatchObject({
        state: "active",
        appearance: { glow: { cycleMs: 900 } },
      });
      h.instance.subscribe([configured(["text"], 0, 1)]);
      expect(h.values.at(-1)).toMatchObject({
        state: "inactive",
        appearance: { glow: null },
      });
      h.set({ protocol: "5.0" });
      h.instance.subscribe([configured(["left", "right"], 0)]);
      expect(h.values.at(-1)).toMatchObject({
        state: "active",
        appearance: { glow: { cycleMs: 1700 } },
      });
      h.instance.subscribe([configured(["text"], 0)]);
      expect(h.values.at(-1)).toMatchObject({
        state: "inactive",
        appearance: { backgroundColor: "#2468AC", glow: null },
      });
      h.set({ fresh: false });
      h.instance.emit();
      expect(h.values.at(-1)).toMatchObject({
        state: "unavailable",
        appearance: { backgroundColor: null, glow: null },
      });
      expect(h.host).not.toHaveBeenCalled();
    } finally {
      await h.instance.close();
    }
  });
  it("keeps feedback disabled and ignores an observer button press", async () => {
    const h = harness(),
      value = request(
        "tally-feedback;feedback=off;colors=#13579B|#2468AC;glow=on",
      );
    await h.instance.start();
    try {
      h.instance.subscribe([value]);
      await h.instance.execute(value.fields);
      expect(h.values.at(-1)?.appearance).toMatchObject({
        backgroundColor: null,
        glow: null,
      });
      expect(h.host).not.toHaveBeenCalled();
    } finally {
      await h.instance.close();
    }
  });
  it("persists column following independently across module restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "module-tally-"));
    const h = harness(directory);
    try {
      await h.instance.start();
      h.instance.subscribe([
        request("tally-feedback"),
        request("tally-feedback", otherColumn),
      ]);
      await h.instance.execute(request("button-tally-unfollow").fields);
      expect(
        [...h.values]
          .reverse()
          .find((value) => value.fields?.actionColumnId === column)?.state,
      ).toBe("inactive");
      expect(
        [...h.values]
          .reverse()
          .find((value) => value.fields?.actionColumnId === otherColumn)?.state,
      ).toBe("active");
      await h.instance.close();
      const restored = harness(directory);
      try {
        await restored.instance.start();
        restored.instance.subscribe([
          request("tally-feedback"),
          request("tally-feedback", otherColumn),
        ]);
        expect(
          [...restored.values]
            .reverse()
            .find((value) => value.fields?.actionColumnId === column)?.state,
        ).toBe("inactive");
        expect(
          [...restored.values]
            .reverse()
            .find((value) => value.fields?.actionColumnId === otherColumn)
            ?.state,
        ).toBe("active");
      } finally {
        await restored.instance.close();
      }
    } finally {
      await h.instance.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("uses approved peers for switch controls and reports unavailable feedback after data access fails", async () => {
  const target = {
    kind: "connection" as const,
    connectionId: randomUUID(),
    moduleId: "hubble-tally-switch",
  };
  let allowed = true,
    readable = true,
    following = true;
  const execute = vi.fn(async (_target, _id, fields) => {
    following =
      fields.mode === "toggle" ? !following : fields.mode === "follow";
    return { status: "success", evidence: { kind: "local", summary: "Saved" } };
  });
  const modules = {
    bindings: async () => (allowed ? [{ target, allowActions: true }] : []),
    query: async () => {
      if (!readable) throw new Error("Read permission revoked");
      return { following };
    },
    subscribe: async () => async () => {},
    execute,
  } as unknown as NonNullable<ModuleContext["modules"]>;
  const h = harness(undefined, modules);
  try {
    await h.instance.start();
    h.instance.subscribe([request("tally-switch-follow")]);
    await vi.waitFor(() => expect(h.values.at(-1)?.state).toBe("active"));
    await h.instance.execute(request("tally-switch-unfollow").fields);
    expect(execute).toHaveBeenCalledWith(
      target,
      "follow",
      { mode: "unfollow" },
      undefined,
    );
    expect(h.values.at(-1)?.state).toBe("inactive");
    readable = false;
    await h.instance.execute(request("tally-switch-follow").fields);
    expect(h.values.at(-1)?.state).toBe("unavailable");
    allowed = false;
    await expect(
      h.instance.execute(request("tally-switch-toggle").fields),
    ).rejects.toThrow("Add a TALLY Switch module");
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    await h.instance.close();
  }
});

it("routes legacy cross-column indication only to an approved owning receiver", async () => {
  const target = {
    kind: "connection" as const,
    connectionId: randomUUID(),
    moduleId: "hubble-tsl",
  };
  const execute = vi.fn(async () => ({
    status: "success",
    evidence: { kind: "local", summary: "Saved" },
  }));
  const modules = {
    bindings: async () => [{ target, allowActions: true }],
    query: async () => [otherColumn],
    execute,
  } as unknown as NonNullable<ModuleContext["modules"]>;
  const h = harness(undefined, modules);
  try {
    await h.instance.start();
    h.instance.subscribe([request("tally-feedback")]);
    await h.instance.execute({
      ...request("set-indication").fields,
      values: {
        actionType: "set-indication",
        targetColumnId: otherColumn,
        indication: false,
      },
    });
    expect(execute).toHaveBeenCalledWith(
      target,
      "set-column-indication",
      { columnId: otherColumn, enabled: false },
      undefined,
    );
  } finally {
    await h.instance.close();
  }
});

it("retains previous indication when saving the follow state fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "matrix-failure-"));
  const h = harness(path.join(directory, "blocked"));
  try {
    await h.instance.start();
    h.instance.subscribe([request("tally-feedback")]);
    await writeFile(path.join(directory, "blocked"), "not a directory");
    await expect(
      h.instance.execute(request("button-tally-unfollow").fields),
    ).rejects.toThrow();
    h.instance.emit();
    expect(h.values.at(-1)?.state).toBe("active");
  } finally {
    await h.instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});
