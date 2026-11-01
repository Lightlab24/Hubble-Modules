import type {
  ModuleExchange,
  ModulePeer,
  ModulePeerDescription,
} from "@hubble/module-sdk";
import {
  CyanViewRcpConnectionDefinitionSchema,
  type CyanViewRcpConnectionDefinition,
} from "./config.js";
import type { CccController } from "./ccc-controller.js";

/** Public connection observations, routed through Hubble; recording decisions stay here. */
export function observeRcpPeers(
  modules: ModuleExchange,
  controller: CccController,
) {
  const entries = new Map<
    string,
    {
      peer: ModulePeer;
      close?: () => Promise<void>;
      definition?: CyanViewRcpConnectionDefinition;
    }
  >();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const apply = () => {
    if (!stopped)
      controller.configureConsumers(
        [...entries.values()].flatMap((entry) =>
          entry.definition ? [entry.definition] : [],
        ),
        true,
      );
  };
  const refresh = async () => {
    const peers = (await modules.discover()).filter(
      (entry: ModulePeerDescription) =>
        entry.peer.kind === "connection" &&
        entry.peer.moduleId === "hubble-cyanview-rcp",
    );
    if (stopped) return;
    const selected = new Map(
      peers.map((entry) => [JSON.stringify(entry.peer), entry]),
    );
    for (const [key, entry] of entries)
      if (!selected.has(key)) {
        entries.delete(key);
        await entry.close?.().catch(() => {});
      }
    apply();
    for (const [key, { peer }] of selected) {
      if (stopped || entries.has(key) || entries.size >= 128) continue;
      const entry: {
        peer: ModulePeer;
        close?: () => Promise<void>;
        definition?: CyanViewRcpConnectionDefinition;
      } = { peer };
      entries.set(key, entry);
      try {
        entry.close = await modules.subscribe(
          { kind: "data", target: peer, id: "connection", version: 1 },
          (event) => {
            if (stopped || entries.get(key) !== entry) return;
            if (event.kind === "data") {
              const definition = CyanViewRcpConnectionDefinitionSchema.parse(
                event.value,
              );
              if (
                peer.kind !== "connection" ||
                definition.connectionId !== peer.connectionId
              )
                throw new Error("RCP observation identity mismatch");
              entry.definition = definition;
            } else if (event.kind === "availability" && !event.available)
              delete entry.definition;
            apply();
          },
        );
        if (stopped) await entry.close().catch(() => {});
      } catch {
        entries.delete(key);
        apply();
      }
    }
  };
  const run = () =>
    (pending ??= refresh().finally(() => {
      pending = undefined;
    }));
  const timer = setInterval(() => {
    void run().catch(() => {});
  }, 1000);
  timer.unref();
  return {
    start: run,
    choices: () =>
      [...entries.values()].flatMap((entry) =>
        entry.definition
          ? [
              {
                id: entry.definition.connectionId,
                label: entry.definition.name,
              },
            ]
          : [],
      ),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending?.catch(() => {});
      await Promise.all(
        [...entries.values()].map((entry) => entry.close?.().catch(() => {})),
      );
      entries.clear();
    },
  };
}
