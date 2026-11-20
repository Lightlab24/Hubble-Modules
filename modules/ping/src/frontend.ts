import { connectModuleFrontend, ModuleFrontendValueSchema } from "@hubble/module-sdk/frontend";
import { confirm, mountSegmented, mountSwitch, showToast } from "@hubble/module-sdk/controls";
import { mountSpreadsheetColumnEditor, mountSpreadsheetToolbar } from "@hubble/module-sdk/spreadsheet-controls";
import type { LiveReply, LiveRequest } from "./backend.js";
import { DraftStore, type SaveReceipt } from "./draft-store.js";
import {
  bytesPerSecond,
  clone,
  columnOf,
  formatInterval,
  formatMs,
  formatRate,
  insertRows,
  INTERVALS_MS,
  MAX_DEVICES,
  newDevice,
  rulesOf,
  ALERT_LOST_MS,
  ALERT_OVER_MS,
  formatDuration,
  removeRows,
  deviceHasData,
  setDeviceCount,
  SIZES_BYTES,
  SPANS,
  spanOf,
  valueOf,
  type Mutation,
  type Settings,
  type SpanId,
  type View,
} from "./model.js";
import { createTimeline } from "./timeline.js";
import { createDeviceGrid } from "./ui-grid.js";
import "./frontend.css";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let lastSaveError = "";

function report(message: string) {
  // Hubble's own fading toast, so an error never moves the page.
  void showToast({ kind: "failure", title: message }).catch(() => undefined);
}

try {
  const client = await connectModuleFrontend(window);
  const initial = (await client.call("snapshot")) as unknown as SaveReceipt;
  const store = new DraftStore(initial, async (operation: Mutation) => {
    return (await client.call("save", ModuleFrontendValueSchema.parse({ operation }))) as unknown as SaveReceipt;
  });
  let live: LiveReply = { sequence: 0, now: Date.now(), problem: "", devices: {}, timeline: null };
  let selectedId: string | undefined = store.document.devices[0]?.id;
  let fetching = false;
  let fetchAgain = false;

  const settings = () => store.document.settings;
  const view = () => store.document.view;
  const setSettings = (change: Partial<Settings>) => store.submit({ kind: "settings", settings: { ...clone(settings()), ...change }, expected: clone(settings()) });
  const setView = (change: Partial<View>) => store.submit({ kind: "view", view: { ...clone(view()), ...change }, expected: clone(view()) });

  // The two dropdowns are plain <select>s: Hubble's stylesheet gives them its own list.
  const every = el<HTMLSelectElement>("every");
  for (const ms of INTERVALS_MS) every.add(new Option(formatInterval(ms), String(ms)));
  every.addEventListener("change", () => setSettings({ intervalMs: Number(every.value) }));
  const size = el<HTMLSelectElement>("size");
  for (const bytes of SIZES_BYTES) size.add(new Option(`${bytes} bytes`, String(bytes)));
  size.addEventListener("change", () => setSettings({ sizeBytes: Number(size.value) }));

  // The alerts every device shares. "Off" is the empty value.
  const alertOver = el<HTMLSelectElement>("alert-over");
  alertOver.add(new Option("Off", ""));
  for (const ms of ALERT_OVER_MS) alertOver.add(new Option(`${ms} ms`, String(ms)));
  alertOver.addEventListener("change", () => setSettings({ alertOverMs: alertOver.value ? Number(alertOver.value) : null }));
  const alertLost = el<HTMLSelectElement>("alert-lost");
  alertLost.add(new Option("Off", ""));
  for (const ms of ALERT_LOST_MS) alertLost.add(new Option(formatDuration(ms), String(ms)));
  alertLost.addEventListener("change", () => setSettings({ alertLostMs: alertLost.value ? Number(alertLost.value) : null }));

  const pinging = await mountSwitch({
    root: el("pinging"),
    label: "Pinging",
    layout: "inline",
    getState: () => ({ checked: settings().pinging, onLabel: "On", offLabel: "Paused" }),
    onCheckedChange: (checked) => {
      setSettings({ pinging: checked });
    },
  });
  const notify = await mountSwitch({
    root: el("notify"),
    label: "Notifications",
    layout: "inline",
    getState: () => ({ checked: settings().notify, onLabel: "On", offLabel: "Off" }),
    onCheckedChange: (checked) => {
      setSettings({ notify: checked });
    },
  });
  const timeline = createTimeline({
    canvas: el<HTMLCanvasElement>("chart"),
    onWindow: () => fetchNow(),
    onHover: (text) => {
      el("tl-hint").textContent = text ?? "Pinch to zoom · two fingers to move through time";
    },
    onFollow: (following) => {
      el("tl-live").hidden = following;
    },
  });
  timeline.setPingTime(settings().intervalMs);
  timeline.showLast(spanOf(view().span).ms);
  el("tl-live").addEventListener("click", () => timeline.backToNow());
  const span = await mountSegmented({
    root: el("span"),
    label: "Show last",
    layout: "inline",
    getState: () => ({ value: view().span, options: SPANS.map((item) => ({ value: item.id, label: item.label })) }),
    onValueChange: (value) => {
      setView({ span: value as SpanId });
      timeline.showLast(spanOf(value).ms);
    },
  });
  const textSize = await mountSpreadsheetToolbar({
    root: el("text-size"),
    textSize: { get: () => view().textSize ?? 13, onChange: (value) => void setView({ textSize: value }) },
  });

  function insert(beforeId: string | null) {
    if (store.document.devices.length >= MAX_DEVICES) {
      report(`Use up to ${MAX_DEVICES} devices.`);
      return;
    }
    const row = newDevice(store.document, crypto.randomUUID());
    if (store.submit(insertRows(store.document, [row], beforeId))) grid.select({ rowId: row.id, columnId: "host" });
  }

  const grid = await createDeviceGrid({
    table: el<HTMLTableElement>("device-grid"),
    viewport: el("viewport"),
    store,
    live: () => live.devices,
    onInsert: insert,
    onRemove: (rowId) => store.submit(removeRows(store.document, [rowId])),
    onSelect(rowId) {
      if (rowId === selectedId) return;
      selectedId = rowId;
      updateTimeline();
      fetchNow();
    },
    onError: report,
  });

  const columnEditor = await mountSpreadsheetColumnEditor({
    root: el("columns"),
    // Device is left out: a row has to stay recognisable, so it can't be hidden or moved.
    getItems: () =>
      view()
        .order.filter((id) => id !== "name")
        .map((id) => ({ id, label: id === "strip" ? spanOf(view().span).heading : columnOf(id)!.label, visible: !view().hidden.includes(id) })),
    onVisibilityChange(id, visible) {
      const hidden = view().hidden.filter((item) => item !== id);
      if (!visible) hidden.push(id);
      const selected = grid.selected();
      if (!visible && selected?.columnId === id) grid.select({ rowId: selected.rowId, columnId: "name" }, false);
      setView({ hidden });
    },
    onMove(id, beforeId) {
      const order = view().order.filter((item) => item !== id);
      const index = beforeId ? order.indexOf(beforeId) : -1;
      order.splice(index < 0 ? order.length : index, 0, id);
      setView({ order });
    },
  });

  function updateTimeline() {
    const row = store.document.devices.find((item) => item.id === selectedId) ?? store.document.devices[0];
    selectedId = row?.id;
    const summary = row ? live.devices[row.id] : undefined;
    const rules = row ? rulesOf(row, settings()) : { overMs: null, lostMs: null };
    const limit = rules.overMs;
    el("tl-name").textContent = row ? valueOf(row, "name") : "No device selected";
    const when = [limit !== null ? `over ${limit} ms` : "", rules.lostMs !== null ? `no answer for ${formatDuration(rules.lostMs)}` : ""].filter(Boolean);
    el("tl-sub").textContent = row ? [valueOf(row, "host") || "No IP address", when.length ? `alert ${when.join(" or ")}` : "no alerts"].join(" · ") : "";
    const stat = (label: string, value: number | null | undefined, percent = false) =>
      `<span>${label} <b>${value === null || value === undefined ? "—" : percent ? `${value.toFixed(1)}%` : formatMs(value)}</b></span>`;
    el("tl-stats").innerHTML = summary && summary.state !== "not-checked"
      ? stat("Now", summary.now) + stat("Average", summary.average) + stat("Best", summary.best) + stat("Worst", summary.worst) + stat("Lost", summary.lostPct, true)
      : "";
    timeline.setData(row && live.timeline?.deviceId === row.id ? live.timeline : undefined, limit);
  }

  function update() {
    textSize.refresh();
    timeline.setPingTime(settings().intervalMs);
    pinging.refresh();
    notify.refresh();
    span.refresh();
    columnEditor.refresh();
    if (every.value !== String(settings().intervalMs)) every.value = String(settings().intervalMs);
    if (size.value !== String(settings().sizeBytes)) size.value = String(settings().sizeBytes);
    const over = settings().alertOverMs === null ? "" : String(settings().alertOverMs);
    if (alertOver.value !== over) alertOver.value = over;
    const lost = settings().alertLostMs === null ? "" : String(settings().alertLostMs);
    if (alertLost.value !== lost) alertLost.value = lost;
    if (store.error !== lastSaveError) {
      lastSaveError = store.error;
      if (lastSaveError) report(lastSaveError);
    }
    const devices = store.document.devices;
    const pingedRows = devices.filter((row) => valueOf(row, "enabled") === "TRUE" && valueOf(row, "host"));
    const states = pingedRows.map((row) => (settings().pinging ? (live.devices[row.id]?.state ?? "not-checked") : "not-checked"));
    const checked = states.filter((state) => state !== "not-checked").length;
    const online = states.filter((state) => state === "online" || state === "slow").length;
    const alerts = states.filter((state) => state === "offline" || state === "slow").length;
    const fleet = el("fleet");
    el("fleet-status").textContent = !devices.length
      ? "No devices yet"
      : !settings().pinging
        ? "Paused"
        : `${online} of ${checked} online · ${alerts} alert${alerts === 1 ? "" : "s"}`;
    fleet.dataset.tone = !settings().pinging || !checked ? "idle" : states.includes("offline") ? "bad" : alerts ? "warn" : "ok";
    const saveStatus = el<HTMLOutputElement>("save-status");
    const problem = store.error || live.problem;
    saveStatus.textContent = problem || (store.pending.length ? "Saving…" : store.invalid.size ? "Correct the highlighted cell" : "All changes saved");
    saveStatus.dataset.error = String(!!problem || store.invalid.size > 0);
    const count = pingedRows.length;
    el("data-use").textContent = settings().pinging
      ? `${count} device${count === 1 ? "" : "s"} · ${settings().sizeBytes} bytes every ${formatInterval(settings().intervalMs)} · about ${formatRate(bytesPerSecond(count, settings()))} in total · Alerts go to the Status Log${settings().notify ? ", a notification" : ""} and any key that shows the device`
      : "Paused · nothing is being sent";
    // Never overwrite the number while it is being typed.
    const counter = el<HTMLInputElement>("device-count");
    if (document.activeElement !== counter && counter.value !== String(devices.length)) counter.value = String(devices.length);
    el("empty").hidden = devices.length > 0;
    el<HTMLButtonElement>("add-device").disabled = devices.length >= MAX_DEVICES;
    updateTimeline();
  }
  store.subscribe(update);

  el("add-device").addEventListener("click", () => insert(null));

  // The Devices box sets how many rows there are: new blank ones at the end, or the last ones taken off.
  const countInput = el<HTMLInputElement>("device-count");
  let counting = false;
  async function applyCount() {
    if (counting) return;
    counting = true;
    try {
      const operation = setDeviceCount(store.document, countInput.value.trim() === "" ? NaN : Number(countInput.value), () => crypto.randomUUID());
      if (!operation) return;
      const { removed, ...mutation } = operation;
      const filled = removed.filter(deviceHasData);
      // Rows that were only counted go without asking. Filled-in ones are named first; Undo brings them back.
      if (filled.length) {
        const names = filled.map((row) => valueOf(row, "name")).join(", ");
        const sure = await confirm({
          title: `Remove ${removed.length} device${removed.length === 1 ? "" : "s"}?`,
          message: `This takes the last ${removed.length === 1 ? "device" : `${removed.length} devices`} off the list, with their addresses and alert settings. Filled in: ${names}. Undo brings them back.`,
          confirmLabel: removed.length === 1 ? "Remove device" : "Remove devices",
          danger: true,
        });
        if (!sure) return;
      }
      store.submit(mutation);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      counting = false;
      countInput.value = String(store.document.devices.length);
    }
  }
  countInput.addEventListener("change", () => void applyCount());
  countInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      countInput.blur();
    }
  });
  el("empty-add").addEventListener("click", () => insert(null));

  function request(after: number): LiveRequest {
    const wanted = timeline.window();
    return { after, span: view().span, ...(selectedId ? { timeline: { deviceId: selectedId, ...wanted } } : {}) };
  }
  function adopt(reply: LiveReply) {
    // A reply for another device or an older moment never replaces a newer one.
    if (reply.sequence < live.sequence) return;
    live = reply.timeline || !selectedId ? reply : { ...reply, timeline: live.timeline?.deviceId === selectedId ? live.timeline : null };
    grid.refreshLive();
    update();
  }

  /** An answer right away, for a new selection or a moved timeline. */
  async function fetchNow() {
    if (fetching) {
      fetchAgain = true;
      return;
    }
    fetching = true;
    try {
      do {
        fetchAgain = false;
        adopt((await client.call("live", ModuleFrontendValueSchema.parse(request(0)))) as unknown as LiveReply);
      } while (fetchAgain);
    } catch {
      /* The follow loop reports a lost connection. */
    } finally {
      fetching = false;
    }
  }

  // Follows ping results while the page is on screen. The worker answers as soon as there is a new one.
  let run = 0;
  async function follow() {
    const mine = ++run;
    while (mine === run && document.visibilityState === "visible") {
      try {
        const reply = (await client.call("live", ModuleFrontendValueSchema.parse(request(live.sequence)))) as unknown as LiveReply;
        if (mine !== run) return;
        adopt(reply);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void follow();
    else run++;
  });
  setInterval(() => timeline.tick(), 250);

  el("loading").hidden = true;
  update();
  void follow();
} catch (error) {
  el("loading").textContent = error instanceof Error ? error.message : String(error);
}
