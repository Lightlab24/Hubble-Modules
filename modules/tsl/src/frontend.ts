import { connectModuleFrontend, MODULE_RESTARTING_MESSAGE } from "@hubble/module-sdk/frontend";
import {
  confirm,
  mountSegmented,
  mountStepper,
  mountSwitch,
  showToast,
  type MountedControl,
} from "@hubble/module-sdk/controls";
import type { LiveReply, PageSnapshot, SetupSaved, SharedReply, TallyRow } from "./page.js";
import {
  defaultSwitcherDocument,
  DeviceNameSchema,
  deviceIdentity,
  deviceLine,
  deviceState,
  documentFromDevice,
  documentFromRow,
  linkStatus,
  listenerProblem,
  sameFormat,
  OFFSETS,
  wantedDevice,
  type ReceiverSettings,
  type SentField,
  type SwitcherDocument,
} from "./setup.js";
import type { SwitcherDeviceRow, SwitcherDeviceSettings, SwitcherReading } from "./switcher/index.js";
import { mountRoutingView } from "./routing-view.js";
import { isPageView, PAGE_VIEWS, type PageView } from "./views.js";
import "./frontend.css";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const COLOURS = ["off", "red", "green", "amber"] as const;
const WORDS = ["Off", "Red", "Green", "Amber"] as const;
/** 3.1 lamps are only on or off. Tally 2 is program on a Ross switcher, tally 1 preview. */
const TALLY_31 = ["green", "red", "amber", "amber"] as const;
const SETTINGS_SAVE_DELAY_MS = 600;
/** How long the module may take to come back after a save before the page says it did not. */
const RESTART_WAIT_MS = 10_000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour12: false });
const format = (link: { protocol: string; transport: string }) => `TSL ${link.protocol} over ${link.transport.toUpperCase()}`;
/** Where each setting of the switcher's device is on the page, for marking one not sent yet. */
const FIELD_ELEMENTS: Record<SentField, string> = {
  name: "device-name",
  ip: "send-to",
  port: "sw-port",
  protocol: "sw-protocol",
  transport: "sw-transport",
  enabled: "enabled",
  screen: "screen",
  offset: "offset",
  brightness: "brightness",
  center: "center",
  fsfc: "fsfc",
  busName: "bus-name",
  umdId: "umd-id",
  oneSecond: "one-second",
  header: "header",
};
type Contact = { reading: SwitcherReading | null; readAt: number | null; readError: string | null; stamp?: string };
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/**
 * A change to the switcher setup this copy has not saved yet. One the page made by itself, such
 * as taking in the device after Read switcher, carries the value it started from: it lands only
 * where the setup still has that value, so it never undoes another window's change.
 */
type Staged = { value: unknown; auto: boolean; expected?: unknown };

function toast(kind: "failure" | "success", title: string) {
  // Hubble's own fading toast, so a message never moves the page.
  void showToast({ kind, title }).catch(() => undefined);
}
const text = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const cell = (value: string, className = "") => {
  const td = document.createElement("td");
  td.textContent = value;
  if (className) td.className = className;
  return td;
};
const head = (labels: readonly (readonly [string, string, number?])[]) => {
  const thead = document.createElement("thead");
  const row = thead.insertRow();
  for (const [label, className, width] of labels) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    if (width) th.style.width = `${width}px`;
    row.append(th);
  }
  return thead;
};

/** This window was opened for a part of the page TSL Tally does not have. */
class PartGone extends Error {}

try {
  const client = await connectModuleFrontend(window);
  /**
   * In a window the sidebar opened for one part (Tally, Routing or Setup): that view, and only
   * it, with no View control. Null in the whole page. Such a window never saves which view is
   * open, so the whole page still opens where the operator left it.
   */
  const part = client.view;
  if (part !== null && !isPageView(part)) throw new PartGone();
  if (part) {
    // Only what belongs to that view. Setup has no tools of its own, so it has no toolbar.
    el("tabs").hidden = true;
    for (const divider of document.querySelectorAll<HTMLElement>(".toolbar-divider")) divider.remove();
    if (part === "setup") el("app").classList.add("no-toolbar");
  }
  const snapshot = (await client.call("snapshot")) as unknown as PageSnapshot;
  /** What the page shows for This computer: what the module runs with, plus changes on their way. */
  const receiver: ReceiverSettings = structuredClone(snapshot.receiver);
  /** What the module runs with. */
  let saved: ReceiverSettings = structuredClone(snapshot.receiver);
  /** The switcher setup as saved, as far as this copy knows. */
  let base: SwitcherDocument = structuredClone(snapshot.switcher.value);
  let revision = snapshot.switcher.revision;
  /** The setup as shown: what is saved, with this copy's changes on their way on top. */
  let switcher: SwitcherDocument = structuredClone(base);
  /** Which reading of the switcher this copy shows, from any window. */
  let stamp = snapshot.stamp;
  /** A reading speaks for the page's device only while that is still the device it found. */
  const own = (from: SwitcherReading | null): SwitcherReading | null =>
    from?.mine && from.mine.name !== deviceIdentity(switcher) && from.mine.name !== switcher.name ? { ...from, mine: null } : from;
  let reading: SwitcherReading | null = own(snapshot.reading);
  let readAt = snapshot.readAt;
  let readError = snapshot.readError;
  let routeAddress = snapshot.routeAddress;
  let tab: PageView = part ?? snapshot.tab;
  let live: LiveReply = snapshot.live;
  /** The Routing tab, once mounted. */
  let routingView: Awaited<ReturnType<typeof mountRoutingView>> | undefined;
  let note = "";
  let noteIsError = false;
  let disposed = false;
  let busy = false;
  const rows = new Map<string, TallyRow>(snapshot.live.rows.map((row) => [row.key, row]));
  const controls: MountedControl[] = [];
  const localAddresses = snapshot.addresses.map((item) => item.id);

  el("instance-name").textContent = snapshot.name || " ";

  // ----- Header and footer: the listener -----
  const drawStatus = () => {
    const listener = live.listener;
    const fresh = [...rows.values()].some((row) => row.fresh);
    const where = `${receiver.transport.toUpperCase()} ${receiver.port} · TSL ${receiver.protocol}`;
    el("listener").dataset.tone = listener.phase === "error" ? "bad" : listener.phase === "listening" && fresh ? "ok" : "idle";
    el("listener-text").textContent =
      listener.phase === "error"
        ? `Not listening · ${listenerProblem({ error: listener.error, bindAddress: saved.bindAddress, port: saved.port, localAddresses })}`
        : listener.phase !== "listening"
          ? "Not listening"
          : `${fresh ? "Receiving" : "Listening"} · ${where}`;
    const tally = listener.lastPacketAt
      ? `Last tally ${clock(listener.lastPacketAt)} from ${listener.lastSender ?? "the switcher"}`
      : "No tally received yet";
    el("status-line").textContent = note ? `${note} · ${tally}` : tally;
    el("status-line").dataset.error = String(noteIsError);
    el("packets").textContent = `Invalid packets ${listener.invalidPackets}`;
  };
  const say = (message: string, error = false) => {
    note = message;
    noteIsError = error;
    drawStatus();
  };

  // ----- Tally: every address the switcher has sent -----
  const grid = el<HTMLTableElement>("tally-grid");
  const body = document.createElement("tbody");
  const drawn = new Map<string, HTMLTableRowElement>();
  let drawnOrder: string | undefined;
  // The sheet shows what the listener receives, so its columns follow the version it runs with.
  let five = saved.protocol === "5.0";
  let lampCount = five ? 3 : 4;
  const paint = (row: HTMLTableRowElement, item: TallyRow, index: number) => {
    row.dataset.stale = String(!item.fresh);
    const cells = row.cells;
    cells[0]!.textContent = String(index + 1);
    cells[1]!.textContent = String(item.address);
    cells[2]!.textContent = item.label || "Unnamed";
    for (let lamp = 0; lamp < lampCount; lamp++) {
      const value = item.lamps[lamp] ?? 0;
      const target = cells[3 + lamp]!;
      // A stale address is unknown, never Off.
      target.textContent = !item.fresh ? "Unknown" : five ? (WORDS[value] ?? "Off") : value ? "On" : "Off";
      target.dataset.tally = !item.fresh ? "unknown" : five ? (COLOURS[value] ?? "off") : value ? TALLY_31[lamp]! : "off";
    }
    cells[3 + lampCount]!.textContent = item.sender;
  };
  const drawTally = () => {
    const query = el<HTMLInputElement>("find").value.trim().toLocaleLowerCase();
    const sorted = [...rows.values()].sort((a, b) => a.screen - b.screen || a.address - b.address);
    const shown = sorted.filter((row) => !query || `${row.address} ${row.label}`.toLocaleLowerCase().includes(query));
    const order = shown.map((row) => row.key).join("|");
    if (order !== drawnOrder) {
      // The set of rows changed: rebuild. Otherwise only the cells that changed are touched.
      drawnOrder = order;
      drawn.clear();
      body.replaceChildren(
        ...shown.map((item, index) => {
          const row = document.createElement("tr");
          row.append(cell("", "row-number"), cell("", "num"), cell(""));
          for (let lamp = 0; lamp < lampCount; lamp++) row.append(cell("", "lamp"));
          row.append(cell("", "quiet"));
          paint(row, item, index);
          drawn.set(item.key, row);
          return row;
        }),
      );
    } else shown.forEach((item, index) => paint(drawn.get(item.key)!, item, index));
    const lit = sorted.filter((row) => row.fresh && row.lamps.some(Boolean)).length;
    el("count").textContent = query ? `${shown.length} of ${sorted.length} addresses` : `${sorted.length} addresses · ${lit} lit`;
    el("tally-empty").hidden = sorted.length > 0;
    el("tally-none").hidden = sorted.length === 0 || shown.length > 0;
  };
  const headTally = () => {
    five = saved.protocol === "5.0";
    lampCount = five ? 3 : 4;
    const lampHeads = five ? ["Left", "Text", "Right"] : ["Tally 1", "Tally 2", "Tally 3", "Tally 4"];
    drawnOrder = undefined;
    grid.replaceChildren(
      head([["", "row-number", 44], ["Address", "num", 92], ["Name", "", 300], ...lampHeads.map((label) => [label, "", 96] as const), ["Sender", "", 170]]),
      body,
    );
  };
  headTally();
  el("find").addEventListener("input", drawTally);

  // ----- Setup: whether the two ends agree -----
  const sendTo = () => switcher.sendTo || routeAddress || "";
  const wanted = () => (sendTo() ? wantedDevice(switcher, receiver, sendTo()) : null);
  /** What the page's device sends, as the page shows it. */
  const device = () => wantedDevice(switcher, receiver, sendTo());
  /** Screen, Address offset, Brightness and TSL header exist on the switcher only for TSL 5.0. */
  const fiveOnlyOff = () => device().protocol === "3.1";
  /** A device just picked from the list, while its form is read, and what was changed here meanwhile. */
  let picking: { name: string; edits: Partial<SwitcherDocument> } | null = null;
  let match: ReturnType<typeof linkStatus>["match"] = null;
  const drawLink = () => {
    const status = picking
      ? { tone: "idle" as const, title: "Reading", text: `Reading ${picking.name} from the switcher…`, match: null }
      : linkStatus({
          receiver,
          reading,
          readError,
          localAddresses,
          listening: live.listener.phase === "listening",
          deviceName: deviceIdentity(switcher),
          hereAddress: routeAddress,
        });
    match = status.match;
    el("link").dataset.tone = status.tone;
    el("link-title").textContent = status.title;
    el("link-text").textContent = status.text;
    el<HTMLButtonElement>("match").disabled = !status.match;
    const mine = picking ? null : reading?.mine;
    const who = mine?.name ?? "the switcher";
    el("match-hint").textContent = status.match
      ? `Listen for what ${who} sends: ${format(status.match)}, port ${status.match.port}${status.match.bindAddress !== receiver.bindAddress ? `, on ${status.match.bindAddress}` : ""}`
      : mine?.settings && !localAddresses.includes(mine.settings.ip)
        ? sameFormat(receiver, mine.settings)
          ? `TSL ${receiver.protocol}, ${receiver.transport.toUpperCase()} and port ${receiver.port} already match`
          : `${mine.name} doesn't send to this computer yet`
        : `Listens for exactly what ${who} sends`;
  };
  const deviceGrid = el<HTMLTableElement>("device-grid");
  const drawSwitcher = () => {
    el("found").dataset.tone = readError ? "bad" : reading ? "ok" : "idle";
    el("found-text").textContent = readError
      ? `Offline · ${readError}`
      : reading
        ? `Online · ${reading.product} · software ${reading.software}${readAt ? ` · read ${clock(readAt)}` : ""}`
        : "Not checked";
    const mine = reading?.mine ?? null;
    const state = picking
      ? { tone: "idle" as const, text: `Reading ${picking.name}…`, onSwitcher: true, unsent: false, fields: [] as SentField[] }
      : deviceState({ reading, wanted: wanted() });
    el("device-state").dataset.tone = state.tone;
    el("device-state-text").textContent = state.text;
    for (const [field, id] of Object.entries(FIELD_ELEMENTS)) {
      const node = el(id);
      (node.closest<HTMLElement>(".box") ?? node).dataset.changed = String(state.fields.includes(field as SentField));
    }
    // No switcher request while Hubble is restarting the module: the restart would cut it short.
    const away = busy || restarting || !!picking;
    el<HTMLButtonElement>("delete").disabled = away || !state.onSwitcher;
    // Nothing to send while the switcher already has every setting shown here.
    el<HTMLButtonElement>("send").disabled = away || !switcher.host || (state.onSwitcher && !!mine?.settings && !state.unsent);
    el<HTMLButtonElement>("read").disabled = busy || restarting || !switcher.host;
    // A new device is already what the page edits until it is sent.
    el<HTMLButtonElement>("new-device").disabled = away || !state.onSwitcher;

    const rows = (reading?.devices ?? []).filter((row) => row.type === "TSL UMD");
    const focused = document.activeElement instanceof HTMLTableRowElement && deviceGrid.contains(document.activeElement) ? document.activeElement.dataset.slot : undefined;
    const deviceBody = document.createElement("tbody");
    for (const row of rows) {
      const line = deviceLine(row, row.slot === mine?.slot);
      const tr = deviceBody.insertRow();
      tr.dataset.mine = String(line.mine);
      tr.dataset.slot = line.slot;
      tr.tabIndex = 0;
      tr.setAttribute("aria-selected", String(line.mine));
      tr.append(cell(line.slot, "num"), cell(line.name), cell(line.format), cell(line.sendsTo, "quiet"), cell(line.enabled));
    }
    deviceGrid.replaceChildren(head([["Slot", "num", 46], ["Name", ""], ["Format", "", 78], ["Sends to", "", 170], ["Enabled", "", 72]]), deviceBody);
    deviceGrid.setAttribute("aria-disabled", String(away));
    if (focused !== undefined) deviceBody.querySelector<HTMLElement>(`tr[data-slot="${focused}"]`)?.focus();
    // The list is four rows high: bring a newly picked device into it, once, and leave the user's own scrolling alone.
    const pickedRow = deviceBody.querySelector<HTMLElement>('tr[data-mine="true"]');
    if (pickedRow && deviceGrid.dataset.shown !== pickedRow.dataset.slot) pickedRow.scrollIntoView({ block: "nearest" });
    deviceGrid.dataset.shown = pickedRow?.dataset.slot ?? "";
    el("devices-empty").hidden = rows.length > 0;
    el("devices-empty").textContent = reading ? "No TSL devices yet" : "Read the switcher to list its devices";
    el("devices-sub").textContent = rows.length ? "Click a device to edit it" : "\u00a0";

    const sub = el("switcher-sub");
    const name = document.createElement("strong");
    if (picking) {
      name.textContent = picking.name;
      sub.replaceChildren(name, " · reading it from the switcher…");
    } else if (mine) {
      name.textContent = mine.name;
      sub.replaceChildren(name, ` · slot ${mine.slot} · as the switcher has it${state.unsent ? ", with your changes" : ""}`);
    } else if (reading) {
      name.textContent = switcher.name;
      sub.replaceChildren(name, " · new device, not on the switcher yet");
    } else sub.textContent = "Read the switcher to see what it has";

    el<HTMLSelectElement>("offset").disabled = fiveOnlyOff();
    const target = sendTo();
    const here = routeAddress && localAddresses.includes(routeAddress) ? routeAddress : null;
    el("link-note").textContent =
      target && !localAddresses.includes(target)
        ? here
          ? `This computer is ${here} on the switcher's network. Choose it in Send to, then send`
          : `${target} isn't this computer, so this device's tally doesn't come here`
        : fiveOnlyOff()
          ? "TSL 3.1 has no Screen, Address offset, Brightness or TSL header"
          : "\u00a0";
    drawLink();
  };

  let frame = 0;
  const scheduleTally = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawTally();
      drawStatus();
      drawLink();
    });
  };
  const follow = async () => {
    while (!disposed) {
      try {
        const reply = (await client.call("live", { after: live.version, run: live.run })) as unknown as LiveReply;
        if (disposed) return;
        // Another run: the module restarted, perhaps for a setting another window saved.
        const restarted = reply.run !== live.run;
        if (reply.full) rows.clear();
        for (const key of reply.removed) rows.delete(key);
        for (const row of reply.rows) rows.set(row.key, row);
        live = reply;
        routingView?.live(reply.routing);
        followSetup();
        if (restarted) readAgain();
        scheduleTally();
      } catch {
        if (disposed) return;
        await pause(restarting ? 100 : 1000);
      }
    }
  };

  // ----- Setup: this computer. Hubble saves these settings, then restarts the listener. -----
  // The page stays open through that restart (`restart: "keep-open"`): nothing is reloaded, a
  // box in use is left alone, and a change made meanwhile is saved next. A save never runs
  // beside a switcher request, because the restart would cut the request short.
  let waiting: Partial<ReceiverSettings> = {};
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Hubble has a save and the module is on its way back. */
  let restarting = false;
  let held = 0;
  /** Asks the backend, and asks again while the module is between two runs. */
  const ask = async (command: string, value?: unknown): Promise<unknown> => {
    const deadline = Date.now() + RESTART_WAIT_MS;
    for (;;) {
      try {
        return await client.call(command, value as never);
      } catch (error) {
        if (disposed || text(error, "") !== MODULE_RESTARTING_MESSAGE || Date.now() > deadline) throw error;
        await pause(100);
      }
    }
  };
  /** The backend as it stands now, taken into the page without touching what is being edited. */
  const take = (fresh: PageSnapshot) => {
    const versionChanged = fresh.receiver.protocol !== saved.protocol;
    saved = structuredClone(fresh.receiver);
    Object.assign(receiver, fresh.receiver, waiting);
    // A change of this copy's own on its way brings back what is saved anyway, with it on top.
    if (!saving && !pending.size) {
      base = structuredClone(fresh.switcher.value);
      revision = fresh.switcher.revision;
      restack();
    }
    // A reading belongs to the address it came from.
    const here = fresh.switcher.value.host === switcher.host;
    reading = here ? own(fresh.reading) : null;
    readAt = here ? fresh.readAt : null;
    readError = here ? fresh.readError : null;
    stamp = fresh.stamp;
    if (here) routeAddress = fresh.routeAddress;
    rows.clear();
    for (const row of fresh.live.rows) rows.set(row.key, row);
    live = fresh.live;
    routingView?.take(fresh.routing, fresh.live.routing);
    if (versionChanged) headTally();
    redraw();
  };
  /** Waits for the module to answer again with these settings, then takes what it says. */
  const back = async (values: Partial<ReceiverSettings>, before: string) => {
    const deadline = Date.now() + RESTART_WAIT_MS;
    let latest: PageSnapshot | null = null;
    for (;;) {
      const fresh = (await client.call("snapshot").catch((error: unknown) => {
        if (disposed) throw error;
        return null;
      })) as unknown as PageSnapshot | null;
      if (fresh) latest = fresh;
      if (fresh && Object.entries(values).every(([id, value]) => fresh.receiver[id as keyof ReceiverSettings] === value)) return take(fresh);
      if (Date.now() > deadline) {
        // Another window saved one of these again after this one, and the module came back with
        // that: the newest change stands, and this copy shows it.
        if (latest && latest.live.run !== before) return take(latest);
        throw new Error("The listener did not come back with these settings");
      }
      await pause(100);
    }
  };
  /** How long a settings save has waited for a switcher request another window has under way. */
  let waitedForSwitcher = 0;
  const flushSettings = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (held || restarting || disposed) return;
    // The restart would cut short a switcher request from another window: it goes first, unless
    // it takes far longer than any request should.
    if (live.setup?.busy && waitedForSwitcher < 150 && Object.keys(waiting).length) {
      waitedForSwitcher += 1;
      saveTimer = setTimeout(flushSettings, 200);
      return;
    }
    waitedForSwitcher = 0;
    // A change put back before it was saved is nothing to save, and Hubble would not restart for it.
    const values = Object.fromEntries(
      Object.entries(waiting).filter(([id, value]) => saved[id as keyof ReceiverSettings] !== value),
    ) as Partial<ReceiverSettings>;
    waiting = {};
    if (!Object.keys(values).length) return;
    restarting = true;
    say("Saving, then restarting the listener…");
    drawSwitcher();
    const before = live.run;
    void (async () => {
      try {
        await client.saveSettings(values);
        await back(values, before);
        say("");
      } catch (error) {
        if (disposed) return;
        // What Hubble refused goes back to what the listener runs with, unless changed again since.
        for (const id of Object.keys(values) as (keyof ReceiverSettings)[])
          if (!(id in waiting)) Object.assign(receiver, { [id]: saved[id] });
        say(text(error, "These settings could not be saved"), true);
        toast("failure", text(error, "These settings could not be saved"));
      } finally {
        restarting = false;
        if (!disposed) {
          redraw();
          // Changes made while the listener restarted are next.
          flushSettings();
        }
      }
    })();
  };
  /** Keeps a save back until the switcher request (and any question before it) is over. */
  const hold = async (work: () => Promise<void>) => {
    held += 1;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    try {
      await work();
    } finally {
      held -= 1;
      if (!held) flushSettings();
    }
  };
  const setReceiver = (change: Partial<ReceiverSettings>, now = false) => {
    Object.assign(receiver, change);
    Object.assign(waiting, change);
    drawStatus();
    drawSwitcher();
    for (const control of controls) control.refresh();
    clearTimeout(saveTimer);
    if (now) flushSettings();
    else saveTimer = setTimeout(flushSettings, SETTINGS_SAVE_DELAY_MS);
  };
  // The module restarted for a reason of its own, such as a save made in Module Connections or in
  // another window. Hubble says so, and the next live answer comes from another run.
  let readingAgain = false;
  const readAgain = () => {
    if (restarting || disposed || readingAgain) return;
    readingAgain = true;
    void ask("snapshot")
      .then(
        (fresh) => {
          if (!disposed && !restarting) take(fresh as PageSnapshot);
        },
        () => undefined,
      )
      .finally(() => {
        readingAgain = false;
      });
  };
  client.onRestart(readAgain);
  /** A box keeps what was typed and turns red when it can't be used; nothing is saved until it can. */
  const shown: (() => void)[] = [];
  /** Shows a value in its box or list again, unless that is where the person is working. */
  const show = (input: HTMLInputElement | HTMLSelectElement, value: () => string) => {
    const write = () => {
      // Never the box in use, and never one still holding an entry that could not be used.
      if (document.activeElement === input || input.getAttribute("aria-invalid") === "true") return;
      input.value = value();
    };
    shown.push(write);
    // Left without a change: it shows what is saved now, which another window may have changed meanwhile.
    input.addEventListener("blur", () => setTimeout(write));
    write();
  };
  /** The Setup tab drawn again from what the page holds now, leaving the box in use alone. */
  const redrawSetup = () => {
    drawSwitcher();
    fillSendTo();
    for (const control of controls) control.refresh();
    for (const write of shown) write();
  };
  /** Everything drawn again from what the page holds now. */
  const redraw = () => {
    drawStatus();
    drawTally();
    redrawSetup();
  };
  const box = <T>(id: string, read: (raw: string) => T | undefined, write: (value: T) => void) => {
    const input = el<HTMLInputElement>(id);
    input.addEventListener("change", () => {
      const value = read(input.value.trim());
      input.setAttribute("aria-invalid", String(value === undefined));
      if (value !== undefined) write(value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur();
    });
  };
  const whole = (min: number, max: number) => (raw: string) => (/^\d+$/u.test(raw) && +raw >= min && +raw <= max ? +raw : undefined);
  const fill = (select: HTMLSelectElement, choices: readonly { id: string; label: string }[], value: string) => {
    select.replaceChildren(...choices.map((choice) => new Option(choice.label, choice.id)));
    select.value = value;
  };
  controls.push(
    await mountSegmented({
      root: el("protocol"),
      label: "TSL version",
      getState: () => ({ value: receiver.protocol, options: [{ value: "3.1", label: "3.1" }, { value: "5.0", label: "5.0" }] }),
      onValueChange: (value) => setReceiver({ protocol: value as "3.1" | "5.0" }),
    }),
    await mountSegmented({
      root: el("transport"),
      label: "Transport",
      getState: () => ({ value: receiver.transport, options: [{ value: "udp", label: "UDP" }, { value: "tcp", label: "TCP" }] }),
      onValueChange: (value) => setReceiver({ transport: value as "udp" | "tcp" }),
    }),
  );
  const port = el<HTMLInputElement>("port");
  show(port, () => String(receiver.port));
  box("port", whole(1, 65535), (value) => setReceiver({ port: value }));
  const bind = el<HTMLSelectElement>("bind");
  fill(
    bind,
    [
      { id: "0.0.0.0", label: "All network addresses" },
      ...snapshot.addresses,
      // A saved address this computer no longer has stays visible, so it can be seen and changed.
      ...(receiver.bindAddress !== "0.0.0.0" && !localAddresses.includes(receiver.bindAddress)
        ? [{ id: receiver.bindAddress, label: `${receiver.bindAddress} · not on this computer` }]
        : []),
    ],
    receiver.bindAddress,
  );
  show(bind, () => receiver.bindAddress);
  bind.addEventListener("change", () => setReceiver({ bindAddress: bind.value }));
  show(el<HTMLInputElement>("sender"), () => receiver.sourceAddress);
  box("sender", (raw) => (raw === "" || IPV4.test(raw) ? raw : undefined), (value) => setReceiver({ sourceAddress: value }));
  show(el<HTMLInputElement>("stale"), () => String(receiver.staleAfterMs));
  box("stale", (raw) => (raw === "0" ? 0 : whole(1000, 3_600_000)(raw)), (value) => setReceiver({ staleAfterMs: value }));
  el("match").addEventListener("click", () => {
    if (!match) return;
    port.value = String(match.port);
    port.setAttribute("aria-invalid", "false");
    if (document.activeElement !== bind) bind.value = match.bindAddress;
    setReceiver(match, true);
  });

  // ----- Setup: the switcher's device. Saved with the workspace; sent only on Send to switcher. -----
  // The page can be open in several windows. Each copy saves only the fields it changed, which the
  // backend puts onto the setup as saved now, and each follows what the others save.
  let saving: Promise<void> | undefined;
  /** This copy's changes not saved yet, and the ones on their way. */
  let pending = new Map<keyof SwitcherDocument, Staged>();
  let sending = new Map<keyof SwitcherDocument, Staged>();
  /** Counts this copy's own changes, so a read that crossed one is not taken in over it. */
  let edited = 0;
  /** The setup as shown again: what is saved, with this copy's changes on top. */
  const restack = () => {
    const next: Record<string, unknown> = { ...base };
    for (const [key, entry] of [...sending, ...pending])
      if (entry.value === undefined || entry.value === null) delete next[key];
      else next[key] = entry.value;
    switcher = next as SwitcherDocument;
  };
  const saveSwitcher = (): Promise<void> => {
    saving ??= (async () => {
      try {
        while (pending.size && !disposed) {
          sending = pending;
          pending = new Map();
          const change: Record<string, unknown> = {};
          const expected: Record<string, unknown> = {};
          for (const [key, entry] of sending) {
            change[key] = entry.value ?? null;
            if (entry.auto) expected[key] = entry.expected ?? null;
          }
          try {
            const reply = (await ask("save-switcher", { change, expected })) as SetupSaved;
            base = reply.value;
            revision = reply.revision;
          } catch (error) {
            if (disposed) return;
            // Refused: only this change is put back, and the copy takes what is saved now, so its
            // next change is not refused for the same reason.
            const fresh = (await ask("saved").catch(() => null)) as SharedReply | null;
            if (fresh) {
              base = fresh.switcher.value;
              revision = fresh.switcher.revision;
            }
            say(text(error, "The switcher setup could not be saved"), true);
            toast("failure", text(error, "The switcher setup could not be saved"));
          }
          sending = new Map();
          restack();
          redrawSetup();
        }
      } finally {
        saving = undefined;
      }
      followSetup();
    })();
    return saving;
  };
  /**
   * Puts a whole new setup on what this copy shows, as changes to the fields that differ, and
   * saves them. `auto` is a change the page makes by itself: see `Staged`.
   */
  const stage = (next: SwitcherDocument, auto: boolean) => {
    for (const key of new Set([...Object.keys(switcher), ...Object.keys(next)]) as Set<keyof SwitcherDocument>) {
      if (sameValue(switcher[key], next[key])) continue;
      const was = pending.get(key) ?? sending.get(key);
      // A field this copy's operator changed and is still saving stays theirs, whatever comes on top.
      pending.set(
        key,
        auto && (!was || was.auto)
          ? { value: next[key], auto: true, expected: was ? was.expected : switcher[key] }
          : { value: next[key], auto: false },
      );
    }
    switcher = next;
    edited += 1;
    void saveSwitcher();
  };
  /** Reads in what another window saved or read from the switcher. Changes of this copy's own win. */
  let followingSetup = false;
  const followSetup = () => {
    const shared = live.setup;
    if (!shared || disposed || followingSetup || restarting) return;
    const setupBehind = shared.revision !== revision && !saving && !pending.size;
    const readingBehind = shared.reading !== stamp && !busy && !picking;
    if (!setupBehind && !readingBehind) return;
    followingSetup = true;
    const at = edited;
    void (ask("saved") as Promise<SharedReply>)
      .then((fresh) => {
        if (disposed) return;
        if (!saving && !pending.size && edited === at) {
          base = fresh.switcher.value;
          revision = fresh.switcher.revision;
          restack();
        }
        if (!busy && !picking) {
          stamp = fresh.stamp;
          // A reading belongs to the address it came from: not one this copy is changing.
          if (fresh.switcher.value.host === switcher.host) {
            reading = own(fresh.reading);
            readAt = fresh.readAt;
            readError = fresh.readError;
            routeAddress = fresh.routeAddress;
          }
        }
        redrawSetup();
        // Something newer may have been announced while this was read.
        setTimeout(followSetup, 50);
      })
      .catch(() => undefined)
      .finally(() => {
        followingSetup = false;
      });
  };
  const sendToSelect = el<HTMLSelectElement>("send-to");
  const fillSendTo = () => {
    // Never the list in use.
    if (document.activeElement === sendToSelect) return;
    // Where a device already sends, when that isn't here, stays a choice: its other settings can
    // change while it keeps feeding what it feeds.
    const elsewhere = [...new Set([switcher.sendTo, reading?.mine?.ip ?? ""])].filter((ip) => IPV4.test(ip) && !localAddresses.includes(ip));
    fill(
      sendToSelect,
      [
        { id: "", label: routeAddress ? `Automatic (${routeAddress})` : "Automatic" },
        ...snapshot.addresses,
        ...elsewhere.map((ip) => ({ id: ip, label: `${ip} · not here` })),
      ],
      switcher.sendTo,
    );
  };
  const setSwitcher = (change: Partial<SwitcherDocument>) => {
    if (change.host !== undefined && change.host !== switcher.host) {
      // A reading belongs to the address it came from.
      reading = null;
      readAt = null;
      readError = null;
      routeAddress = null;
      fillSendTo();
    }
    // A change made while a picked device is read wins over what the switcher says.
    if (picking) Object.assign(picking.edits, change);
    stage({ ...switcher, ...change }, false);
    drawSwitcher();
  };
  /** Version, transport and port go together: changing one stops all three following This computer. */
  const setFormat = (change: Partial<Pick<SwitcherDocument, "protocol" | "transport" | "port">>) => {
    const now = device();
    setSwitcher({ protocol: now.protocol, transport: now.transport, port: now.port, ...change });
  };
  /** The page's setup becomes the device as the switcher has it, keeping what was changed here and not sent. */
  const load = (settings: SwitcherDeviceSettings, edits: Partial<SwitcherDocument>) => {
    const automatic = switcher.sendTo === "" && settings.ip === routeAddress;
    // Taken in by the page itself: where another window changed a field meanwhile, theirs stays.
    stage({ ...documentFromDevice(switcher, settings), ...(automatic ? { sendTo: "" } : {}), ...edits }, true);
  };
  /** The page's changes the switcher doesn't have, as setup values. */
  const unsentEdits = (): Partial<SwitcherDocument> => {
    const now = wanted();
    const edits: Record<string, unknown> = {};
    for (const field of deviceState({ reading, wanted: now }).fields)
      if (field === "ip") edits.sendTo = switcher.sendTo;
      else edits[field] = now?.[field];
    return edits as Partial<SwitcherDocument>;
  };
  const host = el<HTMLInputElement>("host");
  show(host, () => switcher.host);
  box("host", (raw) => (raw.length <= 253 && !/\s/u.test(raw) ? raw : undefined), (value) => setSwitcher({ host: value }));
  fillSendTo();
  sendToSelect.addEventListener("change", () => setSwitcher({ sendTo: sendToSelect.value }));
  show(el<HTMLInputElement>("device-name"), () => switcher.name);
  box("device-name", (raw) => (DeviceNameSchema.safeParse(raw).success ? raw : undefined), (value) => setSwitcher({ name: value }));
  const offset = el<HTMLSelectElement>("offset");
  fill(offset, OFFSETS.map((value) => ({ id: String(value), label: String(value) })), String(switcher.offset));
  show(offset, () => String(switcher.offset));
  offset.addEventListener("change", () => setSwitcher({ offset: Number(offset.value) as SwitcherDocument["offset"] }));
  show(el<HTMLInputElement>("sw-port"), () => String(device().port));
  box("sw-port", whole(1, 65535), (value) => setFormat({ port: value }));
  const toggle = (id: string, label: string, key: "enabled" | "center" | "fsfc" | "busName" | "umdId" | "oneSecond" | "header") =>
    mountSwitch({
      root: el(id),
      label,
      getState: () => ({ checked: switcher[key], disabled: key === "header" && fiveOnlyOff() }),
      onCheckedChange: (checked) => setSwitcher({ [key]: checked }),
    });
  controls.push(
    await mountSegmented({
      root: el("sw-protocol"),
      label: "TSL version",
      getState: () => ({ value: device().protocol, options: [{ value: "3.1", label: "3.1" }, { value: "5.0", label: "5.0" }] }),
      onValueChange: (value) => setFormat({ protocol: value as "3.1" | "5.0" }),
    }),
    await mountSegmented({
      root: el("sw-transport"),
      label: "Transport",
      getState: () => ({ value: device().transport, options: [{ value: "udp", label: "UDP" }, { value: "tcp", label: "TCP" }] }),
      onValueChange: (value) => setFormat({ transport: value as "udp" | "tcp" }),
    }),
    await mountSegmented({
      root: el("brightness"),
      label: "Brightness",
      getState: () => ({ value: String(switcher.brightness), disabled: fiveOnlyOff(), options: [{ value: "0", label: "Off" }, { value: "1", label: "Low" }, { value: "2", label: "Medium" }, { value: "3", label: "High" }] }),
      onValueChange: (value) => setSwitcher({ brightness: Number(value) }),
    }),
    await toggle("enabled", "Enabled", "enabled"),
    await mountStepper({
      root: el("screen"),
      label: "Screen",
      getState: () => ({ value: switcher.screen, min: 0, max: 65534, step: 1, disabled: fiveOnlyOff() }),
      onValueChange: (value) => setSwitcher({ screen: value }),
    }),
    await toggle("center", "Center labels", "center"),
    await toggle("fsfc", "FSFC label", "fsfc"),
    await toggle("bus-name", "Show bus name", "busName"),
    await toggle("umd-id", "Show UMD ID", "umdId"),
    await toggle("one-second", "1 second update", "oneSecond"),
    await toggle("header", "TSL header", "header"),
  );

  // ----- Setup: talking to the switcher. One request at a time; a button keeps its label while it works. -----
  const contact = async (
    button: string,
    working: string,
    done: (at: number) => string,
    command: string,
    value: unknown = {},
    onReply?: (reply: Contact) => void,
  ) => {
    if (busy || restarting) return;
    busy = true;
    el(button).dataset.busy = "true";
    el(button).setAttribute("aria-busy", "true");
    say(working);
    drawSwitcher();
    try {
      await saving;
      const reply = (await client.call(command, value as never)) as unknown as Contact;
      readAt = reply.readAt;
      readError = reply.readError;
      if (reply.stamp) stamp = reply.stamp;
      onReply?.(reply);
      reading = own(reply.reading);
      say(done(reply.readAt ?? Date.now()));
    } catch (error) {
      const message = text(error, "The switcher could not be reached");
      // A failed read means the last reading no longer stands; a failed send or delete leaves it.
      if (command === "read-switcher") {
        reading = null;
        readError = message;
      }
      say(message, true);
      toast("failure", message);
    } finally {
      busy = false;
      delete el(button).dataset.busy;
      el(button).removeAttribute("aria-busy");
      if (!routeAddress && switcher.host) {
        // Which of this computer's addresses reaches the switcher: worked out by the backend.
        const fresh = (await client.call("saved").catch(() => null)) as unknown as SharedReply | null;
        routeAddress = fresh?.routeAddress ?? null;
      }
      redraw();
    }
  };
  const idle = () => !busy && !restarting && !picking;
  /** Moving to another device drops changes not sent to the switcher, so it asks first. */
  const dropUnsent = async (confirmLabel: string): Promise<boolean> => {
    const fields = deviceState({ reading, wanted: wanted() }).fields;
    if (!fields.length) return true;
    const name = reading?.mine?.name ?? switcher.name;
    return confirm({
      title: `Drop the changes to ${name}?`,
      message: `${fields.length === 1 ? "1 change" : `${fields.length} changes`} to ${name} ${fields.length === 1 ? "isn't" : "aren't"} sent to the switcher.`,
      confirmLabel,
    });
  };
  /** Edit another device on the switcher: what its list line says shows at once, its form follows. */
  const pick = (row: SwitcherDeviceRow) => {
    if (!idle() || reading?.mine?.slot === row.slot) return;
    void hold(async () => {
      if (!(await dropUnsent(`Edit ${row.name}`)) || !idle() || !reading) return;
      const edits: Partial<SwitcherDocument> = {};
      picking = { name: row.name, edits };
      stage(documentFromRow(switcher, row), false);
      reading = { ...reading, mine: { ...row, settings: null } };
      redraw();
      try {
        await contact("read", `Reading ${row.name}…`, (at) => `Read ${row.name} ${clock(at)}`, "read-switcher", {}, (reply) => {
          picking = null;
          const mine = reply.reading?.mine;
          if (mine?.settings && mine.name === row.name) load(mine.settings, edits);
        });
      } finally {
        picking = null;
        redraw();
      }
    });
  };
  const rowAt = (target: EventTarget | null) => {
    const tr = target instanceof Element ? target.closest<HTMLTableRowElement>("tbody tr") : null;
    const slot = tr ? Number(tr.dataset.slot) : Number.NaN;
    return reading?.devices.find((row) => row.slot === slot && row.type === "TSL UMD") ?? null;
  };
  deviceGrid.addEventListener("click", (event) => {
    const row = rowAt(event.target);
    if (row) pick(row);
  });
  deviceGrid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = rowAt(event.target);
    if (!row) return;
    event.preventDefault();
    pick(row);
  });
  el("new-device").addEventListener("click", () => {
    if (!idle()) return;
    void hold(async () => {
      if (!(await dropUnsent("New device")) || !idle()) return;
      // A name the switcher doesn't have yet, so sending adds a device rather than changing one.
      const used = new Set((reading?.devices ?? []).map((row) => row.name));
      let name = "HUBBLE";
      for (let n = 2; used.has(name); n++) name = `HUBBLE${n}`;
      const { protocol, transport, port: listenPort } = receiver;
      stage({ ...defaultSwitcherDocument(), host: switcher.host, name, protocol, transport, port: listenPort }, false);
      if (reading) reading = { ...reading, mine: null };
      redraw();
      say(`New device ${name} · Send to switcher adds it`);
    });
  });
  el("read").addEventListener("click", () => {
    if (!idle()) return;
    void hold(async () => {
      // Changes not sent stay; everything else becomes what the switcher has now.
      const edits = unsentEdits();
      await contact("read", "Reading the switcher…", (at) => `Read the switcher ${clock(at)}`, "read-switcher", {}, (reply) => {
        const mine = reply.reading?.mine;
        if (mine?.settings && (mine.name === deviceIdentity(switcher) || mine.name === switcher.name)) load(mine.settings, edits);
      });
    });
  });
  el("send").addEventListener("click", () => {
    if (!idle()) return;
    void hold(async () => {
      const mine = reading?.mine;
      let adopt = false;
      if (mine && !localAddresses.includes(mine.ip)) {
        const target = sendTo();
        adopt = await confirm({
          title: `Change ${mine.name} on the switcher?`,
          message:
            target === mine.ip
              ? `${mine.name} sends to ${mine.ip} : ${mine.port}, which isn't this computer. Sending changes its settings on the switcher, and it keeps sending there.`
              : `${mine.name} now sends to ${mine.ip} : ${mine.port}, which isn't this computer. Sending points it at ${target || "this computer"}.`,
          confirmLabel: "Send to switcher",
        });
        if (!adopt) return;
      }
      // A device saved before 1.3.1 sends what this page shows for This computer, saved yet or not.
      const { protocol, transport, port: listenPort } = receiver;
      const name = switcher.name;
      await contact("send", "Sending to the switcher…", (at) => `Sent ${name} to the switcher ${clock(at)}`, "send-switcher", {
        adopt,
        receiver: { protocol, transport, port: listenPort },
      }, (reply) => {
        // The device is now known on the switcher by the name it was sent with. Saved by the page
        // itself: if another window picked another device meanwhile, that one stays.
        const sent = reply.reading?.mine;
        if (sent && switcher.device !== sent.name) stage({ ...switcher, device: sent.name }, true);
      });
    });
  });
  el("delete").addEventListener("click", () => {
    if (!idle()) return;
    void hold(async () => {
      const mine = reading?.mine;
      const name = mine?.name ?? switcher.name;
      const yes = await confirm({
        title: `Delete ${name} from the switcher?`,
        message:
          mine && !localAddresses.includes(mine.ip)
            ? `${name} sends tally to ${mine.ip} : ${mine.port}, which isn't this computer. Deleting it stops that. The switcher's other devices aren't changed.`
            : "The switcher stops sending tally to this computer. Its other devices aren't changed.",
        confirmLabel: "Delete from switcher",
        danger: true,
      });
      if (yes) await contact("delete", "Deleting from the switcher…", (at) => `Deleted ${name} from the switcher ${clock(at)}`, "delete-switcher");
    });
  });

  // ----- Routing: each output follows the one camera on air (merged in from TALLY Switch) -----
  routingView = await mountRoutingView({
    snapshot: snapshot.routing,
    live: snapshot.live.routing,
    ask,
    failed: (message) => {
      say(message, true);
      toast("failure", message);
    },
    isDisposed: () => disposed,
  });

  // ----- Tabs -----
  const showTab = () => {
    el("tally-view").hidden = tab !== "tally";
    el("routing-view").hidden = tab !== "routing";
    el("setup-view").hidden = tab !== "setup";
    for (const item of document.querySelectorAll<HTMLElement>("[data-for]")) item.hidden = item.dataset.for !== tab;
  };
  // A part's window shows one view: it has no View control, so it never says which view is open.
  if (!part)
    controls.push(
      await mountSegmented({
        root: el("tabs"),
        label: "View",
        // One line in the toolbar (module-controls-inline-v1).
        ...({ layout: "inline" } as object),
        getState: () => ({
          value: tab,
          options: PAGE_VIEWS.map((item) => ({ value: item.view, label: item.title })),
        }),
        onValueChange: (value) => {
          if (!isPageView(value)) return;
          tab = value;
          showTab();
          // Remembered on this computer, so the page comes back to the same tab after a restart.
          void ask("view", { tab }).catch(() => undefined);
        },
      }),
    );
  drawTally();
  drawStatus();
  drawSwitcher();
  showTab();
  el("loading").hidden = true;
  void follow();
  addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(saveTimer);
    for (const control of controls) control.dispose();
    routingView?.dispose();
    client.dispose();
  });
} catch (error) {
  if (error instanceof PartGone) {
    // Hubble's own words for a part of a page that is gone, with nothing else drawn.
    el("app").classList.add("no-toolbar");
    el("listener").hidden = true;
    el("status-line").textContent = "";
    el("loading").textContent = "This part of the page is no longer here.";
  } else {
    el("loading").textContent = "TSL Tally could not open";
    toast("failure", text(error, "TSL Tally could not open"));
  }
}
