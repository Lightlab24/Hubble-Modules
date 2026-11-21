import { connectModuleFrontend, ModuleFrontendValueSchema } from "@hubble/module-sdk/frontend";
import { confirm, mountSegmented, mountStepper, mountSwitch, showToast } from "@hubble/module-sdk/controls";
import { mountSpreadsheetColumnEditor, mountSpreadsheetSheets, mountSpreadsheetToolbar } from "@hubble/module-sdk/spreadsheet-controls";
import type { LiveReply, LiveRequest } from "./backend.js";
import { createColorsEditor } from "./colors-editor.js";
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
  colorsOf,
  roundScale,
  stepScale,
  SCALE_MAX_MS,
  type Bands,
  type Colors,
  ALERT_LOST_MS,
  ALERT_OVER_MS,
  formatDuration,
  removeRows,
  addSheet,
  moveRowsToSheet,
  moveSheet,
  openSheetId,
  removeSheet,
  renameSheet,
  sheetRows,
  sheetsOf,
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
  let selectedId: string | undefined = sheetRows(store.document)[0]?.id;
  let fetching = false;
  /** Counts every change to what the timeline should show: its stretch of time, or its device. */
  let windowVersion = 0;
  /** Whether the timeline results held were asked for by the newest window. */
  let timelineFresh = false;
  let fetchAgain = false;

  const settings = () => store.document.settings;
  const view = () => store.document.view;
  const setSettings = (change: Partial<Settings>) => store.submit({ kind: "settings", settings: { ...clone(settings()), ...change }, expected: clone(settings()) });
  const setView = (change: Partial<View>) => store.submit({ kind: "view", view: { ...clone(view()), ...change }, expected: clone(view()) });
  /** Saves the timeline's scale. Auto is no scale at all, so older versions read the page as before. */
  function setScale(ms: number | null) {
    if (ms === (view().scaleMs ?? null)) return;
    const next = clone(view());
    if (ms === null) delete next.scaleMs;
    else next.scaleMs = ms;
    store.submit({ kind: "view", view: next, expected: clone(view()) });
  }
  /** Saves the times for the bar colours; null goes back to the colours that follow the alert limit. */
  function setBands(bands: Bands | null) {
    const next = clone(view());
    if (bands === null) delete next.bands;
    else next.bands = bands;
    store.submit({ kind: "view", view: next, expected: clone(view()) });
  }
  /** The scale a drag or pinch on the ms numbers is showing before it is saved. */
  let gestureScale: number | null | undefined;

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
    onWindow: () => {
      windowVersion++;
      void fetchNow();
    },
    onHover: (text) => {
      el("tl-hint").textContent = text ?? "Pinch to zoom · two fingers to move through time";
    },
    onFollow: (following) => {
      el("tl-live").hidden = following;
    },
    onScale: (ms, done) => {
      gestureScale = done ? undefined : ms;
      if (done) setScale(ms);
      refreshScale();
    },
    // On Auto the box shows the scale Auto chose, so − and + start from what is on screen.
    onTop: () => {
      if ((view().scaleMs ?? null) === null) refreshScale();
    },
  });

  // The timeline's height: Auto fits the tallest bar on show; any number from the box, − and +,
  // or a drag on the ms numbers holds the top there.
  const shownScale = () => (gestureScale !== undefined ? gestureScale : (view().scaleMs ?? null));
  /** The stepper rounds a typed number to its step, so this is as fine as a typed scale gets. */
  const TYPED_STEP = 0.1;
  /** Set as − or + (or an arrow key) is pressed, so the change it makes is taken as a round step. */
  let stepping: 1 | -1 | 0 = 0;
  el("scale").addEventListener(
    "pointerdown",
    (event) => {
      const label = (event.target as Element).closest("button")?.getAttribute("aria-label") ?? "";
      stepping = label.startsWith("Increase") ? 1 : label.startsWith("Decrease") ? -1 : 0;
    },
    { capture: true },
  );
  el("scale").addEventListener("keydown", (event) => (stepping = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0), { capture: true });
  const scaleAuto = el<HTMLButtonElement>("scale-auto");
  scaleAuto.addEventListener("click", () => setScale(shownScale() === null ? roundScale(timeline.top()) : null));
  const scaleBox = await mountStepper({
    root: el("scale"),
    label: "Scale",
    getState: () => {
      const value = shownScale() ?? timeline.top();
      // min is 0 because the stepper counts its steps from min.
      return { value, min: 0, max: SCALE_MAX_MS, step: TYPED_STEP, unit: "ms" };
    },
    onValueChange: (value) => {
      // − and + (and the arrow keys) go to the next round scale, about a tenth away; a typed number is kept.
      const direction = stepping;
      stepping = 0;
      setScale(direction ? stepScale(shownScale() ?? timeline.top(), direction) : roundScale(value));
    },
  });
  function refreshScale() {
    scaleBox.refresh();
    const auto = shownScale() === null;
    scaleAuto.setAttribute("aria-pressed", String(auto));
    el("scale").dataset.auto = String(auto);
  }

  /** The bar colours for the device on show: from the user's times, or following its alert limit. */
  function shownColors(): Colors {
    const row = sheetRows(store.document).find((item) => item.id === selectedId) ?? sheetRows(store.document)[0];
    return colorsOf(view().bands, row ? rulesOf(row, settings()).overMs : settings().alertOverMs);
  }
  const colorsEditor = createColorsEditor({
    button: el<HTMLButtonElement>("colors"),
    panel: el("colors-panel"),
    get: () => view().bands,
    set: setBands,
    onError: report,
  });
  /** The legend: one chip per band, then over the last band and no answer. */
  let legendKey = "";
  function renderLegend() {
    const colors = shownColors();
    const key = JSON.stringify(colors);
    if (key === legendKey) return;
    legendKey = key;
    const ms = (value: number) => `${Number(value.toPrecision(4))} ms`;
    const chips: [string, string][] = [];
    let from = 0;
    for (const band of colors.bands) {
      chips.push([band.color, from ? `${ms(from).replace(" ms", "")}–${ms(band.upToMs)}` : `Up to ${ms(band.upToMs)}`]);
      from = band.upToMs;
    }
    chips.push([colors.over, colors.bands.length ? `Over ${ms(from)}` : "Answered"]);
    chips.push([colors.lost, "No answer"]);
    el("legend-chips").replaceChildren(
      ...chips.map(([color, text]) => {
        const chip = document.createElement("span");
        const dot = document.createElement("i");
        dot.style.background = color;
        chip.append(dot, text);
        return chip;
      }),
    );
    grid.refreshLive();
  }
  timeline.setPingTime(settings().intervalMs);
  timeline.showLast(spanOf(view().span).ms, true);
  el("tl-live").addEventListener("click", () => timeline.backToNow());
  el("clear-history").addEventListener("click", async () => {
    const sure = await confirm({
      title: "Clear the ping history?",
      message: "This forgets every device's past pings, so the timeline, the strips and the Average, Best, Worst and Lost numbers start again. Devices and alert settings stay. This can't be undone.",
      confirmLabel: "Clear history",
      danger: true,
    });
    if (!sure) return;
    try {
      await client.call("clear-history");
      // What is on screen is the history that was just forgotten.
      live = { ...live, devices: {}, timeline: null };
      grid.refreshLive();
      update();
      void fetchNow();
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  });
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

  /** Removes devices as one undo step. One row goes at once; several are named first when any is filled in. */
  async function removeDevices(rowIds: readonly string[]) {
    const going = store.document.devices.filter((row) => rowIds.includes(row.id));
    if (!going.length) return;
    const filled = going.filter(deviceHasData);
    if (going.length > 1 && filled.length) {
      const names = filled.slice(0, 8).map((row) => valueOf(row, "name")).join(", ");
      const sure = await confirm({
        title: `Remove ${going.length} devices?`,
        message: `This takes ${going.length} devices off the list, with their addresses and alert settings. Filled in: ${names}${filled.length > 8 ? ` and ${filled.length - 8} more` : ""}. Undo brings them back.`,
        confirmLabel: "Remove devices",
        danger: true,
      });
      if (!sure) return;
    }
    // The list may have changed while the question was open.
    const still = going.map((row) => row.id).filter((id) => store.document.devices.some((row) => row.id === id));
    if (still.length) store.submit(removeRows(store.document, still));
  }

  /** Lets the sheet tabs offer "Move selected rows…" as soon as rows are selected. Set once they are mounted. */
  let refreshTabs = () => {};
  const grid = await createDeviceGrid({
    table: el<HTMLTableElement>("device-grid"),
    viewport: el("viewport"),
    store,
    live: () => live.devices,
    rows: () => sheetRows(store.document),
    onInsert: insert,
    onRemove: (rowIds) => void removeDevices(rowIds),
    onSelect(rowId) {
      refreshTabs();
      if (rowId === selectedId) return;
      selectedId = rowId;
      windowVersion++;
      updateTimeline();
      void fetchNow();
    },
    onError: report,
  });

  // Sheets: Hubble's tabs, just above the timeline. Each sheet holds its own devices; all are pinged.
  const tryChange = (make: () => Mutation | null) => {
    try {
      const operation = make();
      if (operation) store.submit(operation);
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  };
  /** Opens a sheet. Which sheet is open is saved with the page but isn't an undo step. */
  function openSheet(id: string) {
    if (id === openSheetId(store.document)) return;
    store.submit({ kind: "view", view: { ...clone(view()), sheetId: id }, expected: clone(view()) }, false);
  }
  const sheetTabs = await mountSpreadsheetSheets({
    root: el("sheet-tabs"),
    getState: () => ({
      sheets: sheetsOf(store.document).map(({ id, name }) => ({ id, name })),
      activeSheetId: openSheetId(store.document),
      counts: new Map(sheetsOf(store.document).map((sheet) => [sheet.id, sheetRows(store.document, sheet.id).length])),
      canMoveSelection: grid.selectedRows().length > 0,
    }),
    onSelect: openSheet,
    onCreate: (name) => tryChange(() => addSheet(store.document, crypto.randomUUID(), name)),
    onRename: (id, name) => tryChange(() => renameSheet(store.document, id, name)),
    onReorder: (id, beforeId) => tryChange(() => moveSheet(store.document, id, beforeId)),
    onMoveSelection: (id) => tryChange(() => moveRowsToSheet(store.document, grid.selectedRows(), id)),
    async onRemove(id) {
      const operation = removeSheet(store.document, id);
      if (!operation) return;
      const { removed, ...mutation } = operation;
      const name = sheetsOf(store.document).find((sheet) => sheet.id === id)?.name ?? "this sheet";
      // An empty sheet, or one with only counted rows, goes at once. Filled-in devices are named first.
      const filled = removed.filter(deviceHasData);
      if (filled.length) {
        const names = filled.slice(0, 8).map((row) => valueOf(row, "name")).join(", ");
        const sure = await confirm({
          title: `Remove the ${name} sheet?`,
          message: `This takes the sheet and its ${removed.length} device${removed.length === 1 ? "" : "s"} off, with their addresses and alert settings, and stops pinging them. Filled in: ${names}${filled.length > 8 ? ` and ${filled.length - 8} more` : ""}. Undo brings them back.`,
          confirmLabel: "Remove sheet",
          danger: true,
        });
        if (!sure) return;
      }
      // The sheets may have changed while the question was open, so work it out again.
      void mutation;
      tryChange(() => {
        const again = removeSheet(store.document, id);
        if (!again) return null;
        const { removed: _gone, ...change } = again;
        return change;
      });
    },
  });

  refreshTabs = () => sheetTabs.refresh();
  // A selection made by dragging or with the keyboard changes no device, so look again after each.
  for (const type of ["pointerup", "keyup"]) el("device-grid").addEventListener(type, () => refreshTabs());

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
    // The timeline shows a device on the open sheet: the one picked there, or else its first.
    const onSheet = sheetRows(store.document);
    const row = onSheet.find((item) => item.id === selectedId) ?? onSheet[0];
    if (row?.id !== selectedId) windowVersion++;
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
    timeline.setBands(view().bands);
    renderLegend();
    colorsEditor.refresh();
    timeline.setData(row && live.timeline?.deviceId === row.id ? live.timeline : undefined, limit, timelineFresh);
    timelineFresh = false;
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
    timeline.setScale(view().scaleMs ?? null);
    refreshScale();
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
    // The Devices box counts the open sheet. Never overwrite the number while it is being typed.
    const onSheet = sheetRows(store.document).length;
    const counter = el<HTMLInputElement>("device-count");
    if (document.activeElement !== counter && counter.value !== String(onSheet)) counter.value = String(onSheet);
    el("empty").hidden = onSheet > 0;
    el("empty-title").textContent = devices.length ? "No devices on this sheet" : "No devices yet";
    el<HTMLButtonElement>("add-device").disabled = devices.length >= MAX_DEVICES;
    sheetTabs.refresh();
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
      countInput.value = String(sheetRows(store.document).length);
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

  /** A request, with what it was asked for, so its answer can be told from a later one's. */
  function request(after: number) {
    const wanted = timeline.window();
    const body: LiveRequest = { after, span: view().span, ...(selectedId ? { timeline: { deviceId: selectedId, ...wanted } } : {}) };
    return { body, span: view().span, version: windowVersion };
  }
  /**
   * Takes an answer. The worker holds a request open until there is a new ping, so an answer can
   * arrive after the time frame, the zoom or the device has changed. Such an answer is for a view
   * that is gone: its table numbers are dropped if the time frame changed, and its timeline is
   * always dropped, or the bars would jump back to the old view and forward again.
   */
  function adopt(reply: LiveReply, asked: { span: string; version: number }) {
    if (reply.sequence < live.sequence || asked.span !== view().span) return;
    const current = asked.version === windowVersion && (!selectedId || reply.timeline?.deviceId === selectedId);
    live = current ? reply : { ...reply, timeline: live.timeline };
    if (current) timelineFresh = true;
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
        const asked = request(0);
        adopt((await client.call("live", ModuleFrontendValueSchema.parse(asked.body))) as unknown as LiveReply, asked);
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
        const asked = request(live.sequence);
        const reply = (await client.call("live", ModuleFrontendValueSchema.parse(asked.body))) as unknown as LiveReply;
        if (mine !== run) return;
        adopt(reply, asked);
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
