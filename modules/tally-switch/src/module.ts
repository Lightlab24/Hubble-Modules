import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  modulePeerKey,
  type HubbleModule,
  type ModulePeerBinding,
  type ModuleActionResult,
  type ModuleJsonValue,
} from "@hubble/module-sdk";
import { rowsSchema, tallySchema, TallySwitchEngine } from "./engine.js";

const module: HubbleModule = {
  createInstance(context) {
    const exchange = context.modules;
    if (!exchange) throw new Error("TALLY Switch requires module exchange");
    const rows = rowsSchema.parse(context.settings.mappings ?? []);
    const controller = new AbortController();
    let bindings: ModulePeerBinding[] = [];
    const subscriptions = new Map<string, () => Promise<void>>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let refreshing = false;
    let writes = Promise.resolve();
    let notice = "Waiting for module data";
    // The bindings and peers the engine was last reconciled against. Provider events keep it
    // current between changes, so a poll that gets the same answer has nothing to do.
    let reconciled: string | undefined;
    let publishedState: string | undefined;
    let publishedFollowing: boolean | undefined;
    const stateFile = context.runtimeDirectory
      ? path.join(context.runtimeDirectory, "following.json")
      : undefined;
    // observedAt timestamps a change, not a heartbeat. Saved settings can't change within a
    // worker generation, so the status rows, notice and follow state decide what is new.
    const publish = () => {
      if (closed) return;
      const following = engine.following ? "Following" : "Unfollowing";
      const state = JSON.stringify([following, notice, engine.statuses]);
      if (state !== publishedState) {
        context.publishState({
          phase: "ready",
          message: null,
          observedAt: new Date().toISOString(),
          values: {
            following,
            notice,
            mappingStatus: {
              settings: JSON.parse(JSON.stringify(context.settings)),
              rows: engine.statuses,
            },
          },
        });
        publishedState = state;
      }
      if (engine.following !== publishedFollowing) {
        context.publishFeedback({
          id: "following",
          state: engine.following ? "active" : "inactive",
          observedAt: new Date().toISOString(),
        });
        publishedFollowing = engine.following;
      }
    };
    const engine = new TallySwitchEngine(
      rows,
      context.settings.enabled === true,
      async (input) => {
        const binding = bindings.find(
          (item) =>
            item.id === input.router && item.allowActions && !item.unresolved,
        );
        if (!binding || controller.signal.aborted)
          throw new Error("Router action permission unavailable");
        const result = await exchange.execute(
          binding.target,
          "route",
          {
            source: input.source,
            destination: input.destination,
            level: input.level,
          },
          controller.signal,
        );
        if (result.status !== "success") throw new Error(result.message);
        return `Submitted · source ${input.source} → output ${input.destination}`;
      },
      publish,
    );
    const refresh = async () => {
      if (refreshing || closed) return;
      refreshing = true;
      try {
        const [next, peers] = await Promise.all([
          exchange.bindings(controller.signal),
          exchange.discover(controller.signal),
        ]);
        if (closed) return;
        const signature = JSON.stringify([next, peers]);
        if (signature === reconciled) return;
        // Set first: an event or failure during this pass clears it, so the next poll repeats it.
        reconciled = signature;
        bindings = next;
        const wanted = new Set<string>();
        for (const binding of bindings) {
          const peer = peers.find(
            (item) =>
              modulePeerKey(item.peer) === modulePeerKey(binding.target),
          );
          const id = peer?.data.some(
            (item) => item.id === "tally" && item.version === 1,
          )
            ? "tally"
            : peer?.data.some(
                  (item) => item.id === "router" && item.version === 1,
                )
              ? "router"
              : null;
          if (id === "router") {
            const previous = engine.routers.get(binding.id);
            engine.routers.set(binding.id, {
              ready: !!peer?.available && (previous?.ready ?? false),
              approved:
                binding.allowActions &&
                !binding.unresolved &&
                !!peer?.actionsAllowed,
            });
          }
          if (!id || binding.unresolved || !peer?.available) {
            engine.tallies.delete(binding.id);
            continue;
          }
          const key = JSON.stringify([
            binding.id,
            modulePeerKey(binding.target),
            id,
          ]);
          wanted.add(key);
          if (subscriptions.has(key)) continue;
          let generation: string | null | undefined;
          const unsubscribe = await exchange.subscribe(
            { kind: "data", target: binding.target, id, version: 1 },
            (event) => {
              if (closed) return;
              if (event.kind === "availability") {
                if (!event.available) {
                  reconciled = undefined;
                  engine.tallies.delete(binding.id);
                  engine.routers.delete(binding.id);
                  generation = undefined;
                  engine.baseline(binding.id);
                  engine.evaluate(false);
                }
                return;
              }
              if (event.kind !== "data") return;
              const freshGeneration = generation !== event.generation;
              generation = event.generation;
              if (freshGeneration) engine.baseline(binding.id);
              if (id === "tally") {
                const value = tallySchema.safeParse(event.value);
                if (value.success) engine.tallies.set(binding.id, value.data);
                else engine.tallies.delete(binding.id);
              } else {
                const value = z
                  .object({ ready: z.boolean() })
                  .safeParse(event.value);
                // Approval here ignores the peer's answer; the next pass restores the full rule.
                reconciled = undefined;
                engine.routers.set(binding.id, {
                  ready: value.success && value.data.ready,
                  approved: bindings.some(
                    (item) =>
                      item.id === binding.id &&
                      item.allowActions &&
                      !item.unresolved,
                  ),
                });
              }
              engine.evaluate(id === "tally" && !freshGeneration);
            },
            controller.signal,
          );
          if (closed) {
            await unsubscribe();
            break;
          }
          subscriptions.set(key, unsubscribe);
        }
        for (const [key, unsubscribe] of subscriptions)
          if (!wanted.has(key)) {
            subscriptions.delete(key);
            await unsubscribe();
          }
        const used = new Set(rows.map((row) => row.values.receiver));
        for (const id of engine.tallies.keys())
          if (
            !bindings.some(
              (binding) =>
                binding.id === id && !binding.unresolved && used.has(id),
            )
          )
            engine.tallies.delete(id);
        notice = peers.length
          ? "Receiving module data."
          : "Add a TSL receiver and a router to this workspace.";
        engine.evaluate(false);
      } catch (error) {
        if (!closed) {
          reconciled = undefined;
          engine.tallies.clear();
          engine.routers.clear();
          notice =
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Module data unavailable";
          engine.evaluate(false);
        }
      } finally {
        refreshing = false;
      }
    };
    const follow = (mode: "follow" | "unfollow" | "toggle"): Promise<void> => {
      const save = writes.then(async () => {
        if (closed) throw new Error("TALLY Switch stopped");
        const value = mode === "toggle" ? !engine.following : mode === "follow";
        if (stateFile) {
          await mkdir(path.dirname(stateFile), { recursive: true });
          await writeFile(
            `${stateFile}.tmp`,
            JSON.stringify({ following: value }),
            { mode: 0o600 },
          );
          await rename(`${stateFile}.tmp`, stateFile);
        }
        if (closed) return;
        engine.setFollowing(value);
        await exchange.publish("following", 1, { following: value });
      });
      writes = save.catch(() => {});
      return save;
    };
    return {
      async start() {
        if (stateFile) {
          try {
            const text = await readFile(stateFile, "utf8");
            if (text.length > 1024) throw new Error("Invalid follow state");
            engine.following = z
              .object({ following: z.boolean() })
              .parse(JSON.parse(text)).following;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await refresh();
        publish();
        await exchange.publish("following", 1, { following: engine.following });
        timer = setInterval(() => {
          void refresh();
        }, 1000);
        timer.unref();
      },
      async execute(id, fields, execution): Promise<ModuleActionResult> {
        if (execution.signal.aborted)
          return {
            status: "failure",
            category: "cancelled",
            message: "Cancelled before changing follow state",
          };
        const mode = z
          .enum(["follow", "unfollow", "toggle"])
          .safeParse(fields.mode);
        if (id !== "follow" || !mode.success)
          return {
            status: "failure",
            category: "invalid-config",
            message: "Invalid follow action",
          };
        await follow(mode.data);
        return {
          status: "success",
          evidence: {
            kind: "local",
            summary: "TALLY Switch follow state saved",
          },
        };
      },
      async call(method, value, execution): Promise<ModuleJsonValue> {
        execution.signal.throwIfAborted();
        if (method === "follow") {
          await follow(z.enum(["follow", "unfollow", "toggle"]).parse(value));
          return { following: engine.following };
        }
        if (method === "page.tally-switch") {
          const command = z
            .object({ commandId: z.literal("toggle") })
            .parse(value);
          if (command.commandId === "toggle") await follow("toggle");
          return { message: engine.following ? "Following" : "Unfollowing" };
        }
        throw new Error("Unknown TALLY Switch control");
      },
      queryData(query) {
        if (query.id !== "following" || query.version !== 1)
          throw new Error("Unknown data query");
        return { following: engine.following };
      },
      async choices(provider) {
        const [allBindings, peers] = await Promise.all([
          exchange.bindings(),
          exchange.discover(),
        ]);
        const dataId =
          provider === "receiver"
            ? "tally"
            : provider === "router"
              ? "router"
              : "";
        return allBindings
          .filter(
            (binding) =>
              !binding.unresolved &&
              peers.some(
                (peer) =>
                  modulePeerKey(peer.peer) === modulePeerKey(binding.target) &&
                  peer.data.some((data) => data.id === dataId),
              ),
          )
          .map((binding) => ({ id: binding.id, label: binding.name }));
      },
      async dispose() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        controller.abort();
        engine.close();
        await writes;
        await Promise.allSettled(
          [...subscriptions.values()].map((unsubscribe) => unsubscribe()),
        );
        subscriptions.clear();
      },
    };
  },
};
export default module;
