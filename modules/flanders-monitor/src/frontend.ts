import { connectModuleFrontend, ModuleFrontendValueSchema } from "@hubble/module-sdk/frontend";
import { mountSpreadsheetToolbar } from "@hubble/module-sdk/spreadsheet-controls";
import type { Statuses } from "./backend.js";
import { DraftStore, type SaveReceipt } from "./draft-store.js";
import { clone, insertRows, MAX_MONITORS, newMonitor, removeRows, type Mutation } from "./model.js";
import { createMonitorGrid } from "./ui-grid.js";
import "./frontend.css";

type Snapshot = SaveReceipt & { statuses: Statuses; sequence?: number };
type StatusReply = { statuses?: Statuses; sequence?: number; message?: string };

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const errorBox = el("error");
let statuses: Statuses = {};
// Hubble delivers state on its own cycle, so an older copy can arrive after a newer reply.
let newest = 0;
let errorTimer: ReturnType<typeof setTimeout> | undefined;
let lastSaveError = "";

function adopt(next: StatusReply) {
  if (!next.statuses) return;
  if (typeof next.sequence === "number") {
    if (next.sequence < newest) return;
    newest = next.sequence;
  }
  statuses = next.statuses;
}

function report(message: string) {
  clearTimeout(errorTimer);
  errorBox.getAnimations().forEach((animation) => animation.cancel());
  errorBox.textContent = message;
  errorBox.hidden = !message;
  if (message) {
    errorBox.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 4250, fill: "forwards" });
    errorTimer = setTimeout(() => (errorBox.hidden = true), 4500);
  }
}

try {
  const client = await connectModuleFrontend(window);
  const initial = (await client.call("snapshot")) as unknown as Snapshot;
  adopt(initial);
  const store = new DraftStore(initial, async (operation: Mutation) => {
    const reply = (await client.call("save", ModuleFrontendValueSchema.parse({ operation }))) as unknown as Snapshot;
    adopt(reply);
    return reply;
  });

  const textSize = await mountSpreadsheetToolbar({
    root: el("text-size"),
    textSize: {
      get: () => store.document.view.textSize ?? 13,
      onChange(size) {
        store.submit({ kind: "view", view: { ...clone(store.document.view), textSize: size }, expected: clone(store.document.view) });
      },
    },
  });

  function insert(beforeId: string | null) {
    if (store.document.monitors.length >= MAX_MONITORS) {
      report(`Use up to ${MAX_MONITORS} monitors.`);
      return;
    }
    const row = newMonitor(store.document, crypto.randomUUID());
    if (store.submit(insertRows(store.document, [row], beforeId))) grid.select({ rowId: row.id, columnId: "host" });
  }

  const grid = await createMonitorGrid({
    table: el<HTMLTableElement>("monitor-grid"),
    viewport: el("viewport"),
    store,
    statuses: () => statuses,
    onInsert: insert,
    onRemove: (rowId) => store.submit(removeRows(store.document, [rowId])),
    onError: report,
  });

  function update() {
    textSize.refresh();
    if (store.error !== lastSaveError) {
      lastSaveError = store.error;
      if (lastSaveError) report(lastSaveError);
    }
    const count = store.document.monitors.length;
    const held = store.document.monitors.filter((row) => statuses[row.id]?.tone === "held").length;
    el("fleet-status").textContent = `${count} monitor${count === 1 ? "" : "s"}${held ? ` · ${held} in use by another app` : ""}`;
    el("fleet-status").parentElement!.dataset.ready = String(count > 0);
    const saveStatus = el<HTMLOutputElement>("save-status");
    saveStatus.textContent = store.error || (store.pending.length ? "Saving…" : store.invalid.size ? "Correct the highlighted cell" : "Workspace saved");
    saveStatus.dataset.error = String(!!store.error || store.invalid.size > 0);
    el("empty").hidden = count > 0;
    el<HTMLButtonElement>("add-monitor").disabled = count >= MAX_MONITORS;
  }
  store.subscribe(update);

  el("add-monitor").addEventListener("click", () => insert(null));
  el("empty-add").addEventListener("click", () => insert(null));

  const checkButton = el<HTMLButtonElement>("check-apps");
  const checkResult = el<HTMLOutputElement>("check-result");
  checkButton.addEventListener("click", async () => {
    checkButton.disabled = true;
    el("check-label").textContent = "Checking…";
    try {
      const reply = (await client.call("check")) as unknown as StatusReply;
      adopt(reply);
      checkResult.textContent = reply.message ?? "";
      checkResult.dataset.tone = reply.message?.startsWith("Another") ? "held" : "ok";
      grid.refresh();
      update();
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      checkButton.disabled = false;
      el("check-label").textContent = "Check for other apps";
    }
  });

  // Follows key results while the page is on screen. The worker answers as soon as a status changes.
  let run = 0;
  async function follow() {
    const mine = ++run;
    while (mine === run && document.visibilityState === "visible") {
      try {
        adopt((await client.call("changes", { after: newest })) as unknown as StatusReply);
        if (mine !== run) return;
        grid.refresh();
        update();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void follow();
    else run++;
  });

  el("loading").hidden = true;
  update();
  void follow();
} catch (error) {
  el("loading").textContent = error instanceof Error ? error.message : String(error);
}
