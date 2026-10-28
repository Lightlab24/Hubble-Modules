import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCccMutation,
  CccConfigSchema,
  CyanViewRcpConnectionDefinitionSchema,
  type CccConfig,
} from "../src/config.js";
import { CccController } from "../src/ccc-controller.js";
import { RcpSession } from "../src/rcp-session.js";
import { readFileSync } from "node:fs";
import manifest from "../src/manifest.js";
import { broker, closeBrokers } from "./loopback-broker.js";
const providers: CccController[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()));
  await closeBrokers();
});
async function setup(
  options: {
    enabled?: boolean;
    feedback?: boolean;
    capabilities?: boolean;
    initialRecording?: string;
    connector?: boolean;
  } = {},
) {
  const network = await broker();
  network.controls.feedback = options.feedback ?? true;
  network.controls.capabilities = options.capabilities ?? true;
  network.controls.initialRecording = options.initialRecording ?? "0";
  const workspaceId = randomUUID();
  const connection = CyanViewRcpConnectionDefinitionSchema.parse({
    type: "cyanview-rcp",
    connectionId: randomUUID(),
    name: "Simulated RCP",
    host: "127.0.0.1",
    port: network.port,
    enabled: true,
    requestTimeoutMs: 1000,
    schemaVersion: 1,
  });
  let config: CccConfig = CccConfigSchema.parse({
    revision: 0,
    rows: [101, 102].map((cameraNumber) => ({
      rowId: randomUUID(),
      rcpIp: "127.0.0.1",
      cameraNumber,
      enabled: options.enabled ?? true,
    })),
  });
  const sessions: RcpSession[] = [];
  const provider = new CccController(
    {
      read: () => Promise.resolve(config),
      mutate: (request) => {
        config = applyCccMutation(config, request.mutation);
        return Promise.resolve(config);
      },
    },
    40,
    (definition, changed) => {
      if (definition.host !== "127.0.0.1")
        throw new Error("Only loopback is allowed in this test");
      const session = new RcpSession(definition, changed);
      sessions.push(session);
      return session;
    },
  );
  providers.push(provider);
  provider.configureConsumers([connection], options.connector ?? true);
  await provider.activate(workspaceId);
  await expect
    .poll(() =>
      provider.state().rows.every((row) => row.connection === "online"),
    )
    .toBe(true);
  return { provider, workspaceId, connection, network, sessions };
}
describe("CCC provider against a loopback MQTT simulator", () => {
  it("exposes the new controls through the module action manifest", () => {
    expect(manifest.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "single-switch",
          label: "Single switch",
          completion: "local",
        }),
        expect.objectContaining({
          id: "base-gain-up-enabled-cameras",
          completion: "response",
        }),
        expect.objectContaining({
          id: "base-gain-down-enabled-cameras",
          completion: "response",
        }),
        expect.objectContaining({
          id: "save-white-balance-preset-enabled-cameras",
          completion: "response",
        }),
      ]),
    );
  });

  it("steps camera-defined Base Gain only on cameras advertising gain_mode", async () => {
    const { provider, workspaceId, network, sessions } = await setup();
    network.send("unit/a/camhead/status/persist/gain_mode", "3200", true);
    await expect
      .poll(() => sessions[0]?.cameraObservations()[0]?.baseGain)
      .toBe("3200");
    for (const command of [
      "base-gain-up-enabled-cameras",
      "base-gain-down-enabled-cameras",
    ] as const) {
      const result = await provider.command({ workspaceId, command });
      expect(result.results.map(({ phase }) => phase)).toEqual([
        "sent",
        "error",
      ]);
      expect(result.results[1]?.message).toContain(
        "has not reported Base Gain support",
      );
    }
    expect(network.commands).toEqual([
      {
        topic: "unit/a/camhead/action/next/gain_mode",
        value: "",
        header: 0x32,
      },
      {
        topic: "unit/a/camhead/action/prev/gain_mode",
        value: "",
        header: 0x32,
      },
    ]);
    network.send("unit/a/camhead/status/persist/gain_mode", "");
    await expect
      .poll(() => sessions[0]?.cameraObservations()[0]?.baseGain)
      .toBeNull();
    expect(
      (
        await provider.command({
          workspaceId,
          command: "base-gain-up-enabled-cameras",
        })
      ).results.every(({ phase }) => phase === "error"),
    ).toBe(true);
    expect(network.commands).toHaveLength(2);
  });

  it("uses the documented ND-clear capability before a clear-status topic arrives", async () => {
    const { provider, workspaceId, network, sessions } = await setup();
    network.send(
      "unit/a/camhead/status/volatile/capabilities",
      "00 00 00 00 00 00 00 20 00 00 00 00 00 80",
    );
    await expect
      .poll(() => sessions[0]?.cameraObservations()[0]?.variableNd)
      .toBe(true);
    await provider.command({ workspaceId, command: "nd-up-enabled-cameras" });
    expect(network.commands).toEqual([
      {
        topic: "unit/a/camhead/action/mult/nd_filter",
        value: "2",
        header: 0x32,
      },
      {
        topic: "unit/b/camhead/action/next/nd_filter",
        value: "",
        header: 0x32,
      },
    ]);
  });

  it("matches both captured Sony VENICE Add preset presses and leaves other models and recording alone", async () => {
    const { provider, workspaceId, network, sessions } = await setup({
      initialRecording: "1",
    });
    network.send("unit/a/camhead/status/persist/model", "Venice", true);
    network.send("unit/b/camhead/status/persist/model", "FX3", true);
    await expect
      .poll(() => sessions[0]?.cameraObservations().map(({ model }) => model))
      .toEqual(["Venice", "FX3"]);
    const before = provider.state().config;
    for (let index = 0; index < 2; index++) {
      const result = await provider.command({
        workspaceId,
        command: "save-white-balance-preset-enabled-cameras",
      });
      expect(result.results.map(({ phase }) => phase)).toEqual([
        "sent",
        "error",
      ]);
      expect(result.moduleResult.targets[0]?.evidence).toBe("delivered");
      expect(result.results[1]?.message).toContain("only for Sony VENICE");
    }
    const captured: unknown = JSON.parse(
      readFileSync(
        new URL("./fixtures/sony-venice-add-preset.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      network.commands.map(({ topic, value, header }) => ({
        topic: topic.replace("unit/a/", "{host}/{camera}/"),
        payload: value,
        retained: (header & 1) !== 0,
      })),
    ).toEqual(captured);
    expect(provider.state().config).toEqual(before);
    expect(provider.state().rows.map(({ recording }) => recording)).toEqual([
      "recording",
      "recording",
    ]);
    await provider.mutate({
      workspaceId,
      mutation: {
        kind: "enabled",
        rowId: requiredTestValue(before.rows[0]).rowId,
        enabled: false,
      },
    });
    await provider.command({
      workspaceId,
      command: "save-white-balance-preset-enabled-cameras",
    });
    expect(network.commands).toHaveLength(2);
  });

  it("shares Single switch mode and feedback across actions, survives reload, and enables only the pressed camera", async () => {
    const { provider, workspaceId, network } = await setup();
    const [a, b] = provider.state().config.rows;
    await provider.command({ workspaceId, command: "single-switch" });
    expect(provider.feedback()["single-switch/"]).toBe(true);
    expect(provider.state().config.rows.map(({ enabled }) => enabled)).toEqual([
      true,
      false,
    ]);
    await Promise.all([
      provider.command({
        workspaceId,
        command: "toggle-camera-enabled",
        rowId: requiredTestValue(b).rowId,
      }),
      provider.command({
        workspaceId,
        command: "toggle-camera-enabled",
        rowId: requiredTestValue(a).rowId,
      }),
    ]);
    await provider.command({
      workspaceId,
      command: "toggle-camera-enabled",
      rowId: requiredTestValue(a).rowId,
    });
    await provider.activate(workspaceId);
    expect(provider.state().config.singleSwitch).toBe(true);
    expect(provider.state().config.rows.map(({ enabled }) => enabled)).toEqual([
      true,
      false,
    ]);
    expect(
      provider.feedback()[
        `toggle-camera-enabled/${requiredTestValue(b).rowId}`
      ],
    ).toBe(false);
    await provider.command({ workspaceId, command: "enable-all-cameras" });
    expect(provider.feedback()["single-switch/"]).toBe(false);
    expect(provider.state().config.rows.every(({ enabled }) => enabled)).toBe(
      true,
    );
    expect(network.commands).toEqual([]);
  });
  it("shares discovery, decisions and per-camera queues across CCC and CyanView callers", async () => {
    const { provider, workspaceId, connection, network } = await setup();
    const start = await provider.command({
      workspaceId,
      command: "roll-enabled-cameras",
    });
    expect(start.moduleResult.targets.map(({ evidence }) => evidence)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(network.commands.map(({ value }) => value)).toEqual([
      "Rec",
      "RecToggle",
    ]);
    const toggle = await provider.cameraCommand(
      connection.connectionId,
      "record-camera",
      101,
    );
    expect(toggle.outcome).toBe("success");
    expect(network.commands[2]).toMatchObject({
      topic: "unit/a/camhead/action/set/keyboard",
      value: "Stop",
      header: 0x32,
    });
    expect(network.connections).toBe(1);
  });
  it("preserves no-ops and uses enabled rows matching the invoking RCP", async () => {
    const { provider, workspaceId, connection, network } = await setup({
      initialRecording: "1",
    });
    const start = await provider.command({
      workspaceId,
      command: "roll-enabled-cameras",
    });
    expect(start.moduleResult.targets.map(({ evidence }) => evidence)).toEqual([
      "noop",
      "noop",
    ]);
    expect(network.commands).toEqual([]);
    await provider.mutate({
      workspaceId,
      mutation: {
        kind: "enabled",
        rowId: requiredTestValue(provider.state().config.rows[1]).rowId,
        enabled: false,
      },
    });
    expect(
      (
        await provider.cameraCommand(
          connection.connectionId,
          "stop-enabled-cameras",
        )
      ).targets,
    ).toHaveLength(1);
    expect(
      network.commands.map(({ topic, value }) => ({ topic, value })),
    ).toEqual([{ topic: "unit/a/camhead/action/set/keyboard", value: "Stop" }]);
  });
  it("keeps ordinary recording available without a CCC connector and never broadens enabled-only actions", async () => {
    const { provider, connection, network } = await setup({ connector: false });
    expect(
      (
        await provider.cameraCommand(
          connection.connectionId,
          "record-camera",
          101,
        )
      ).outcome,
    ).toBe("success");
    await expect(
      provider.cameraCommand(connection.connectionId, "start-enabled-cameras"),
    ).rejects.toThrow("missing or disabled");
    await expect(
      provider.cameraCommand(connection.connectionId, "record-group-all"),
    ).rejects.toThrow("membership is unavailable");
    expect(network.commands).toHaveLength(1);
    expect(
      network.commands.every(({ topic }) => !topic.includes("/camgroup/")),
    ).toBe(true);
  });
  it("honors both lock scopes independently and lets unlocked cameras proceed", async () => {
    const { provider, workspaceId, network } = await setup();
    network.send("unit/a/camhead/status/persist/rec_lock", "1");
    network.send("unit/a/camhead/status/volatile/rec_lock", "0");
    await expect
      .poll(() => provider.state().rows[0]?.message)
      .toBe("Recording locked");
    const result = await provider.command({
      workspaceId,
      command: "roll-enabled-cameras",
    });
    expect(result.moduleResult.targets.map(({ evidence }) => evidence)).toEqual(
      ["skipped", "confirmed"],
    );
    network.send("unit/a/camhead/status/volatile/rec_lock", "1");
    network.send("unit/a/camhead/status/persist/rec_lock", "0");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.state().rows[0]?.message).toBe("Recording locked");
    network.send("unit/a/camhead/status/volatile/rec_lock", "0");
    await expect.poll(() => provider.state().rows[0]?.message).toBe("Online");
    expect(
      (await provider.command({ workspaceId, command: "roll-enabled-cameras" }))
        .moduleResult.outcome,
    ).toBe("success");
    expect(network.commands.map(({ value }) => value)).toEqual([
      "RecToggle",
      "Rec",
    ]);
  });
  it("requires capabilities for recording while leaving exposure actions at delivery semantics", async () => {
    const { provider, workspaceId, network } = await setup({
      capabilities: false,
    });
    const recording = await provider.command({
      workspaceId,
      command: "roll-enabled-cameras",
    });
    expect(recording.moduleResult.outcome).toBe("failure");
    expect(network.commands).toEqual([]);
    const exposure = await provider.command({
      workspaceId,
      command: "iso-up-enabled-cameras",
    });
    expect(
      exposure.moduleResult.targets.map(({ evidence }) => evidence),
    ).toEqual(["delivered", "delivered"]);
    expect(
      network.commands.every(({ topic }) =>
        topic.endsWith("/camhead/action/next/master_gain"),
      ),
    ).toBe(true);
  });
  it("blocks a later CyanView call after an unconfirmed CCC send until live feedback arrives", async () => {
    const { provider, workspaceId, connection, network } = await setup({
      feedback: false,
    });
    expect(
      (await provider.command({ workspaceId, command: "roll-enabled-cameras" }))
        .moduleResult.outcome,
    ).toBe("failure");
    expect(
      (
        await provider.cameraCommand(
          connection.connectionId,
          "record-camera",
          101,
        )
      ).outcome,
    ).toBe("failure");
    expect(network.commands).toHaveLength(2);
    network.send("unit/a/camhead/status/volatile/recording", "1");
    await expect
      .poll(() => provider.state().rows[0]?.recording)
      .toBe("recording");
    network.controls.feedback = true;
    expect(
      (
        await provider.cameraCommand(
          connection.connectionId,
          "record-camera",
          101,
        )
      ).outcome,
    ).toBe("success");
    expect(network.commands[2]?.value).toBe("Stop");
  });
});

function requiredTestValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing test fixture value");
  return value;
}
