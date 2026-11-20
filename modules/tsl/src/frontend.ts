import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import {
  confirm,
  mountSegmented,
  mountStepper,
  mountSwitch,
  showToast,
  type MountedControl,
} from "@hubble/module-sdk/controls";
import type { LiveReply, PageSnapshot, TallyRow } from "./page.js";
import {
  DeviceNameSchema,
  deviceLine,
  deviceState,
  linkStatus,
  OFFSETS,
  wantedDevice,
  type ReceiverSettings,
  type SwitcherDocument,
} from "./setup.js";
import type { SwitcherReading } from "./switcher/index.js";
import "./frontend.css";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const COLOURS = ["off", "red", "green", "amber"] as const;
const WORDS = ["Off", "Red", "Green", "Amber"] as const;
/** 3.1 lamps are only on or off. Tally 2 is program on a Ross switcher, tally 1 preview. */
const TALLY_31 = ["green", "red", "amber", "amber"] as const;
const SETTINGS_SAVE_DELAY_MS = 600;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;
const clock = (time: number) => new Date(time).toLocaleTimeString([], { hour12: false });

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

try {
  const client = await connectModuleFrontend(window);
  const snapshot = (await client.call("snapshot")) as unknown as PageSnapshot;
  const receiver: ReceiverSettings = structuredClone(snapshot.receiver);
  let switcher: SwitcherDocument = structuredClone(snapshot.switcher.value);
  let revision = snapshot.switcher.revision;
  let reading: SwitcherReading | null = snapshot.reading;
  let readAt = snapshot.readAt;
  let readError = snapshot.readError;
  let routeAddress = snapshot.routeAddress;
  let tab = snapshot.tab;
  let live: LiveReply = snapshot.live;
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
        ? `Not listening · ${listener.error ?? "the port could not be opened"}`
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
  const five = receiver.protocol === "5.0";
  const lampCount = five ? 3 : 4;
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
  const lampHeads = five ? ["Left", "Text", "Right"] : ["Tally 1", "Tally 2", "Tally 3", "Tally 4"];
  grid.replaceChildren(
    head([["", "row-number", 44], ["Address", "num", 92], ["Name", "", 300], ...lampHeads.map((label) => [label, "", 96] as const), ["Sender", "", 170]]),
    body,
  );
  el("find").addEventListener("input", drawTally);

  // ----- Setup: whether the two ends agree -----
  const sendTo = () => switcher.sendTo || routeAddress || "";
  const wanted = () => (sendTo() ? wantedDevice(switcher, receiver, sendTo()) : null);
  let match: ReturnType<typeof linkStatus>["match"] = null;
  const drawLink = () => {
    const status = linkStatus({ receiver, reading, readError, localAddresses, listening: live.listener.phase === "listening" });
    match = status.match;
    el("link").dataset.tone = status.tone;
    el("link-title").textContent = status.title;
    el("link-text").textContent = status.text;
    el<HTMLButtonElement>("match").disabled = !status.match;
  };
  const drawSwitcher = () => {
    el("found").dataset.tone = readError ? "bad" : reading ? "ok" : "idle";
    el("found-text").textContent = readError
      ? `Offline · ${readError}`
      : reading
        ? `Online · ${reading.product} · software ${reading.software}${readAt ? ` · read ${clock(readAt)}` : ""}`
        : "Not checked";
    const state = deviceState({ reading, wanted: wanted() });
    el("device-state").dataset.tone = state.tone;
    el("device-state-text").textContent = state.text;
    el<HTMLButtonElement>("delete").disabled = busy || !state.onSwitcher;
    el<HTMLButtonElement>("send").disabled = busy || !switcher.host;
    el<HTMLButtonElement>("read").disabled = busy || !switcher.host;
    const lines = (reading?.devices ?? []).filter((row) => row.type === "TSL UMD").map((row) => deviceLine(row, row.name === switcher.name));
    const deviceBody = document.createElement("tbody");
    for (const line of lines) {
      const row = deviceBody.insertRow();
      row.dataset.mine = String(line.mine);
      row.append(cell(line.slot, "num"), cell(line.name), cell(line.format), cell(line.sendsTo, "quiet"), cell(line.enabled));
    }
    el("device-grid").replaceChildren(head([["Slot", "num", 46], ["Name", ""], ["Format", "", 78], ["Sends to", "", 170], ["Enabled", "", 72]]), deviceBody);
    el("devices-empty").hidden = lines.length > 0;
    el("devices-empty").textContent = reading ? "No TSL devices yet" : "Read the switcher to list its devices";
    el("devices-sub").textContent = lines.some((line) => line.mine) ? "The highlighted one is this computer's" : "Sending adds one for this computer";
    el<HTMLSelectElement>("offset").disabled = receiver.protocol === "3.1";
    el("link-note").textContent =
      receiver.protocol === "3.1"
        ? "TSL 3.1 has no Screen, Address offset, Brightness or TSL header"
        : "Send to switcher uses this computer's TSL version, transport and port";
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
        const reply = (await client.call("live", { after: live.version })) as unknown as LiveReply;
        if (disposed) return;
        if (reply.full) rows.clear();
        for (const key of reply.removed) rows.delete(key);
        for (const row of reply.rows) rows.set(row.key, row);
        live = reply;
        scheduleTally();
      } catch {
        if (disposed) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  // ----- Setup: this computer. Hubble saves these settings, then restarts the listener. -----
  let waiting: Partial<ReceiverSettings> = {};
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const flushSettings = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const values = waiting;
    waiting = {};
    if (!Object.keys(values).length) return;
    say("Saving, then restarting the listener…");
    // Hubble reloads the page once the listener has restarted, so nothing waits on success.
    // Hubble closing this page for that reload is the expected end, not a failure to report.
    client.saveSettings(values).catch((error: unknown) => {
      if (disposed || /^Module page (?:closed|reloaded)/u.test(text(error, ""))) return;
      say(text(error, "These settings could not be saved"), true);
      toast("failure", text(error, "These settings could not be saved"));
    });
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
  /** A box keeps what was typed and turns red when it can't be used; nothing is saved until it can. */
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
  port.value = String(receiver.port);
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
  bind.addEventListener("change", () => setReceiver({ bindAddress: bind.value }));
  el<HTMLInputElement>("sender").value = receiver.sourceAddress;
  box("sender", (raw) => (raw === "" || IPV4.test(raw) ? raw : undefined), (value) => setReceiver({ sourceAddress: value }));
  el<HTMLInputElement>("stale").value = String(receiver.staleAfterMs);
  box("stale", (raw) => (raw === "0" ? 0 : whole(1000, 3_600_000)(raw)), (value) => setReceiver({ staleAfterMs: value }));
  const peer = el<HTMLSelectElement>("peer");
  fill(peer, [{ id: "", label: "Automatic (the only TALLY Switch)" }, ...snapshot.peers], receiver.routingPeer);
  peer.addEventListener("change", () => setReceiver({ routingPeer: peer.value }));
  el("match").addEventListener("click", () => {
    if (!match) return;
    port.value = String(match.port);
    port.setAttribute("aria-invalid", "false");
    setReceiver(match, true);
  });

  // ----- Setup: the switcher's device. Saved with the workspace; sent only on Send to switcher. -----
  let saving: Promise<void> | undefined;
  let unsaved = false;
  const saveSwitcher = (): Promise<void> => {
    unsaved = true;
    saving ??= (async () => {
      try {
        while (unsaved && !disposed) {
          unsaved = false;
          const value = structuredClone(switcher);
          let reply = (await client.call("save-switcher", { value, revision })) as unknown as { status: string; revision: string | null };
          // Someone else saved in between. This edit is the newer one, so it goes on top.
          if (reply.status === "conflict")
            reply = (await client.call("save-switcher", { value, revision: reply.revision })) as unknown as typeof reply;
          if (reply.status !== "saved") throw new Error("The switcher setup changed elsewhere. Try again");
          revision = reply.revision;
        }
      } catch (error) {
        // The value stays as the operator left it; the next edit tries again.
        say(text(error, "The switcher setup could not be saved"), true);
        toast("failure", text(error, "The switcher setup could not be saved"));
      } finally {
        saving = undefined;
      }
    })();
    return saving;
  };
  /** Screen, Address offset, Brightness and TSL header exist on the switcher only for TSL 5.0. */
  const fiveOnlyOff = () => receiver.protocol === "3.1";
  const sendToSelect = el<HTMLSelectElement>("send-to");
  const fillSendTo = () =>
    fill(sendToSelect, [{ id: "", label: routeAddress ? `Automatic (${routeAddress})` : "Automatic" }, ...snapshot.addresses], switcher.sendTo);
  const setSwitcher = (change: Partial<SwitcherDocument>) => {
    if (change.host !== undefined && change.host !== switcher.host) {
      // A reading belongs to the address it came from.
      reading = null;
      readAt = null;
      readError = null;
      routeAddress = null;
      fillSendTo();
    }
    switcher = { ...switcher, ...change };
    drawSwitcher();
    void saveSwitcher();
  };
  const host = el<HTMLInputElement>("host");
  host.value = switcher.host;
  box("host", (raw) => (raw.length <= 253 && !/\s/u.test(raw) ? raw : undefined), (value) => setSwitcher({ host: value }));
  fillSendTo();
  sendToSelect.addEventListener("change", () => setSwitcher({ sendTo: sendToSelect.value }));
  el<HTMLInputElement>("device-name").value = switcher.name;
  box("device-name", (raw) => (DeviceNameSchema.safeParse(raw).success ? raw : undefined), (value) => setSwitcher({ name: value }));
  const offset = el<HTMLSelectElement>("offset");
  fill(offset, OFFSETS.map((value) => ({ id: String(value), label: String(value) })), String(switcher.offset));
  offset.addEventListener("change", () => setSwitcher({ offset: Number(offset.value) as SwitcherDocument["offset"] }));
  const toggle = (id: string, label: string, key: "enabled" | "center" | "fsfc" | "busName" | "umdId" | "oneSecond" | "header") =>
    mountSwitch({
      root: el(id),
      label,
      getState: () => ({ checked: switcher[key], disabled: key === "header" && fiveOnlyOff() }),
      onCheckedChange: (checked) => setSwitcher({ [key]: checked }),
    });
  controls.push(
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
  const contact = async (button: string, working: string, done: (at: number) => string, command: string, value: unknown = {}) => {
    if (busy) return;
    busy = true;
    el(button).dataset.busy = "true";
    el(button).setAttribute("aria-busy", "true");
    say(working);
    drawSwitcher();
    try {
      await saving;
      const reply = (await client.call(command, value as never)) as unknown as { reading: SwitcherReading | null; readAt: number | null; readError: string | null };
      reading = reply.reading;
      readAt = reply.readAt;
      readError = reply.readError;
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
        const fresh = (await client.call("snapshot").catch(() => null)) as unknown as PageSnapshot | null;
        routeAddress = fresh?.routeAddress ?? null;
        fillSendTo();
      }
      drawSwitcher();
    }
  };
  el("read").addEventListener("click", () => void contact("read", "Reading the switcher…", (at) => `Read the switcher ${clock(at)}`, "read-switcher"));
  el("send").addEventListener("click", async () => {
    if (busy) return;
    const mine = reading?.mine;
    let adopt = false;
    if (mine && !localAddresses.includes(mine.ip)) {
      adopt = await confirm({
        title: `Change ${mine.name} on the switcher?`,
        message: `${mine.name} now sends to ${mine.ip} : ${mine.port}, which isn't this computer. Sending points it at ${sendTo() || "this computer"}.`,
        confirmLabel: "Send to switcher",
      });
      if (!adopt) return;
    }
    void contact("send", "Sending to the switcher…", (at) => `Sent to the switcher ${clock(at)}`, "send-switcher", { adopt });
  });
  el("delete").addEventListener("click", async () => {
    if (busy) return;
    const yes = await confirm({
      title: `Delete ${switcher.name} from the switcher?`,
      message: "The switcher stops sending tally to this computer. Its other devices aren't changed.",
      confirmLabel: "Delete from switcher",
      danger: true,
    });
    if (yes) void contact("delete", "Deleting from the switcher…", (at) => `Deleted from the switcher ${clock(at)}`, "delete-switcher");
  });

  // ----- Tabs -----
  const showTab = () => {
    el("tally-view").hidden = tab !== "tally";
    el("setup-view").hidden = tab !== "setup";
    for (const item of document.querySelectorAll<HTMLElement>("[data-for]")) item.hidden = item.dataset.for !== tab;
  };
  controls.push(
    await mountSegmented({
      root: el("tabs"),
      label: "View",
      // One line in the toolbar (module-controls-inline-v1).
      ...({ layout: "inline" } as object),
      getState: () => ({ value: tab, options: [{ value: "tally", label: "Tally" }, { value: "setup", label: "Setup" }] }),
      onValueChange: (value) => {
        tab = value as "tally" | "setup";
        showTab();
        // Remembered on this computer, so the page comes back to the same tab after a restart.
        void client.call("view", { tab }).catch(() => undefined);
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
    client.dispose();
  });
} catch (error) {
  el("loading").textContent = "TSL Tally could not open";
  toast("failure", text(error, "TSL Tally could not open"));
}
