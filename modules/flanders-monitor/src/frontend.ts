import { connectModuleFrontend } from "@hubble/module-sdk/frontend";
import { mountSpreadsheetToolbar } from "@hubble/module-sdk/spreadsheet-controls";
import type { Statuses } from "./backend.js";
import { textSizeChange } from "./changes.js";
import type { SaveReceipt } from "./draft-store.js";
import { insertRows, MAX_MONITORS, newMonitor, removeRows } from "./model.js";
import { openMonitorList } from "./page-store.js";
import { createMonitorGrid } from "./ui-grid.js";
import "./frontend.css";

type StatusReply = { statuses?: Statuses; sequence?: number; message?: string; revision?: unknown };

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

/** Floats a message over the page for a few seconds, so it never moves anything. A note is not an error. */
function report(message: string, tone: "error" | "note" = "error") {
  clearTimeout(errorTimer);
  errorBox.getAnimations().forEach((animation) => animation.cancel());
  errorBox.textContent = message;
  errorBox.dataset.tone = tone;
  errorBox.hidden = !message;
  if (message) {
    errorBox.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 4250, fill: "forwards" });
    errorTimer = setTimeout(() => (errorBox.hidden = true), 4500);
  }
}

try {
  const client = await connectModuleFrontend(window);
  // Every open copy of this page, in any HubDash window, follows what the others save.
  const list = await openMonitorList(client, (reply) => adopt(reply as SaveReceipt & StatusReply));
  const { store, follow } = list;
  adopt(list.initial as SaveReceipt & StatusReply);
  store.onClash((clashes) => {
    const unique = [...new Set(clashes)];
    report(`${unique.length === 1 ? `${unique[0]} was` : `${unique.slice(0, 4).join(", ")}${unique.length > 4 ? " and more" : ""} were`} also changed in another window. What you entered here is kept.`, "note");
  });

  const textSize = await mountSpreadsheetToolbar({
    root: el("text-size"),
    textSize: {
      get: () => store.document.view.textSize ?? 13,
      onChange: (size) => store.submit(textSizeChange(store.document, size)),
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
      follow.saw(reply.revision);
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
  async function followStatus() {
    const mine = ++run;
    while (mine === run && document.visibilityState === "visible") {
      try {
        const reply = (await client.call("changes", { after: newest })) as unknown as StatusReply;
        adopt(reply);
        follow.saw(reply.revision);
        if (mine !== run) return;
        grid.refresh();
        update();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void followStatus();
    else run++;
  });

  el("loading").hidden = true;
  update();
  void followStatus();
  window.addEventListener(
    "pagehide",
    () => {
      run++;
      list.close();
    },
    { once: true },
  );
} catch (error) {
  el("loading").textContent = error instanceof Error ? error.message : String(error);
}
