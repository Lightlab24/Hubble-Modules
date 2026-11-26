import { test, expect, type APIRequestContext, type FrameLocator, type Locator, type Page } from "@playwright/test";

// HubDash can show the TSL Tally page in several windows at once. Each window is its own copy of
// the page with its own bridge, all talking to the one running module. These run two copies of the
// built page side by side, in two browser pages, against the real backend in tools/preview.ts with
// its pretend Ross switcher and pretend router. Real clicks and key presses go to one copy; the
// other has to follow without a reload, and neither may refuse, lose or undo the other's work.
// Nothing here reaches a real switcher or router.

interface Copy {
  readonly page: Page;
  readonly f: FrameLocator;
}
const inspect = async (request: APIRequestContext) => (await request.get("/__inspect")).json();
const simulate = async (request: APIRequestContext, value: Record<string, unknown>) => {
  expect((await request.post("/__simulate", { data: value })).ok()).toBe(true);
};
const savedRows = async (request: APIRequestContext) =>
  (await inspect(request)).routing.rows as { id: string; name: string; source: number; destination: number }[];
const savedRow = async (request: APIRequestContext, id: string) => (await savedRows(request)).find((row) => row.id === id);
const savedSetup = async (request: APIRequestContext) => (await inspect(request)).document as Record<string, unknown>;

async function open(page: Page): Promise<Copy> {
  await page.goto("/");
  const f = page.frameLocator("iframe");
  await expect(f.locator("#loading")).toBeHidden({ timeout: 15_000 });
  return { page, f };
}
/** Copies of the page on one freshly started module, as HubDash windows. */
async function copies(page: Page, request: APIRequestContext, count: number): Promise<Copy[]> {
  expect((await request.post("/__reset", { data: {} })).ok()).toBe(true);
  const opened = [await open(page)];
  while (opened.length < count) opened.push(await open(await page.context().newPage()));
  return opened;
}
async function twoCopies(page: Page, request: APIRequestContext): Promise<[Copy, Copy]> {
  const [one, two] = await copies(page, request, 2);
  return [one!, two!];
}
const tab = (copy: Copy, name: "Tally" | "Routing" | "Setup") => copy.f.locator("#tabs").getByRole("radio", { name });
async function show(copy: Copy, name: "Tally" | "Routing" | "Setup") {
  await tab(copy, name).click();
  await expect(tab(copy, name)).toHaveAttribute("aria-checked", "true");
}
const cell = (copy: Copy, row: string, column: string) =>
  copy.f.locator(`#routing-grid td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
/** Real key presses into a camera cell, left open as someone still typing leaves it. */
async function startTyping(copy: Copy, row: string, column: string, text: string): Promise<Locator> {
  await cell(copy, row, column).click();
  await copy.page.keyboard.type(text);
  const input = cell(copy, row, column).locator("input.cell-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(text);
  return input;
}
async function typeCell(copy: Copy, row: string, column: string, text: string, shows = true) {
  const input = await startTyping(copy, row, column, text);
  await copy.page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  if (shows) await expect(cell(copy, row, column)).toHaveText(text);
}
/** Real key presses into a box on the Setup tab, then Enter. */
async function typeBox(copy: Copy, id: string, text: string) {
  const box = copy.f.locator(`#${id}`);
  await box.click();
  await box.press("ControlOrMeta+a");
  await copy.page.keyboard.type(text);
  await box.press("Enter");
}
const toggle = (copy: Copy, id: string) => copy.f.locator(`#${id} [role="switch"]`);
const failures = (copy: Copy) => copy.f.locator('.hubble-toast[data-kind="failure"]');
/** Neither copy was reloaded, and neither showed a refusal or an error. */
async function noTrouble(copies: readonly Copy[]) {
  for (const copy of copies) {
    expect(await copy.page.evaluate(() => (window as unknown as { __loads?: number }).__loads)).toBe(1);
    await expect(failures(copy)).toHaveCount(0);
    await expect(copy.f.locator("#status-line")).toHaveAttribute("data-error", "false");
  }
}

/** Notes the first frame after a cell shows `text`, by the clock this computer and the test share. */
const frameWhenShown = (target: Locator, text: string) =>
  target.evaluate((td, wanted) => {
    const seen = window as unknown as { __shownAt?: number };
    delete seen.__shownAt;
    const observer = new MutationObserver(() => {
      if (td.textContent !== wanted || seen.__shownAt) return;
      observer.disconnect();
      requestAnimationFrame(() => (seen.__shownAt = Date.now()));
    });
    observer.observe(td, { childList: true, characterData: true, subtree: true });
  }, text);
const shownAt = (target: Locator) => target.evaluate(() => (window as unknown as { __shownAt?: number }).__shownAt ?? 0);

test("an edit in one copy shows in the other at once, without a reload", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Routing");
  await show(two, "Routing");

  // Enter in the first copy, to the first frame drawn with it in each copy.
  await frameWhenShown(cell(one, "camera-2", "name"), "Jib");
  await frameWhenShown(cell(two, "camera-2", "name"), "Jib");
  await startTyping(one, "camera-2", "name", "Jib");
  const pressed = Date.now();
  await one.page.keyboard.press("Enter");
  await expect(cell(two, "camera-2", "name")).toHaveText("Jib");
  await expect.poll(() => shownAt(cell(two, "camera-2", "name"))).toBeGreaterThan(0);
  const here = (await shownAt(cell(one, "camera-2", "name"))) - pressed;
  const there = (await shownAt(cell(two, "camera-2", "name"))) - pressed;
  test.info().annotations.push({ type: "Enter to the first frame showing it", description: `this copy ${here} ms, the other copy ${there} ms` });
  console.log(`Enter to the first frame showing it: this copy ${here} ms, the other copy ${there} ms`);
  // The copy typed in shows it in the frame after Enter; the other, once saved and announced.
  expect(here).toBeLessThan(100);
  expect(there).toBeLessThan(1000);

  await typeCell(two, "camera-3", "source", "35");
  await expect(cell(one, "camera-3", "source")).toHaveText("35");
  expect(await savedRow(request, "camera-2")).toMatchObject({ name: "Jib" });
  expect(await savedRow(request, "camera-3")).toMatchObject({ source: 35 });

  // Follow tally, kept on this computer, is one switch for every window.
  await toggle(two, "follow").click();
  await expect(toggle(one, "follow")).toHaveAttribute("aria-checked", "true");
  await expect(one.f.locator("#follow-state-text")).toContainText("Following");
  await noTrouble([one, two]);
});

test("three copies saving at the same moment all keep their edits, and then sit quietly", async ({ page, request }) => {
  const three = await copies(page, request, 3);
  for (const copy of three) await show(copy, "Routing");
  await simulate(request, { holdSaves: true });
  await typeCell(three[0]!, "camera-1", "name", "One");
  await three[1]!.f.locator("#add-camera").click();
  await typeCell(three[2]!, "camera-4", "destination", "7");
  await simulate(request, { releaseSaves: true });

  await expect.poll(async () => (await savedRows(request)).length).toBe(5);
  const rows = await savedRows(request);
  expect(rows.slice(0, 4).map((row) => [row.id, row.name, row.destination])).toEqual([
    ["camera-1", "One", 2],
    ["camera-2", "Camera 2", 2],
    ["camera-3", "Camera 3", 2],
    ["camera-4", "Camera 4", 7],
  ]);
  expect(rows[4]).toMatchObject({ name: "Camera 5", destination: 2 });
  for (const copy of three) {
    await expect(copy.f.locator("#routing-grid tbody tr")).toHaveCount(5);
    await expect(cell(copy, "camera-1", "name")).toHaveText("One");
    await expect(cell(copy, "camera-4", "destination")).toHaveText("7");
    await expect(cell(copy, rows[4]!.id, "name")).toHaveText("Camera 5");
  }
  const { counts } = await inspect(request);
  expect(counts.routingWrites).toBe(3);
  expect(counts.routingConflicts).toBeLessThanOrEqual(3);

  // Once all three hold what is saved, none of them reads or writes again by itself.
  await three[0]!.page.waitForTimeout(500);
  const before = await inspect(request);
  await three[0]!.page.waitForTimeout(2500);
  const after = await inspect(request);
  expect(after.counts.routingWrites + after.counts.switcherWrites).toBe(before.counts.routingWrites + before.counts.switcherWrites);
  for (const command of ["saved", "snapshot", "routing-save", "save-switcher"])
    expect(after.calls[command] ?? 0, `${command} asked while idle`).toBe(before.calls[command] ?? 0);
  await noTrouble(three);
});

test("a save the workspace refuses puts back only that edit, and the next edit lands", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Routing");
  await show(two, "Routing");
  await simulate(request, { failNextSave: true });
  // Refused at once: what was typed may already be put back by the time it could be looked at.
  await typeCell(one, "camera-1", "name", "Refused", false);
  await expect(cell(one, "camera-1", "name")).toHaveText("Camera 1");
  await expect(failures(one)).toContainText("The workspace refused this save.");
  await expect(failures(two)).toHaveCount(0);
  // Its next edit is not refused for the same reason, and the other copy's edits carry on.
  await typeCell(one, "camera-1", "name", "Kept");
  await typeCell(two, "camera-2", "name", "Also kept");
  await expect.poll(async () => (await savedRows(request)).map((row) => row.name).slice(0, 2)).toEqual(["Kept", "Also kept"]);
  await expect(cell(two, "camera-1", "name")).toHaveText("Kept");
  await expect(cell(one, "camera-2", "name")).toHaveText("Also kept");

  // The same for the switcher setup.
  await show(one, "Setup");
  await show(two, "Setup");
  await simulate(request, { failNextSave: true });
  await toggle(two, "center").click();
  await expect(toggle(two, "center")).toHaveAttribute("aria-checked", "false");
  await expect(failures(two)).toContainText("The workspace refused this save.");
  await toggle(two, "center").click();
  await expect.poll(async () => (await savedSetup(request)).center).toBe(true);
  await expect(toggle(one, "center")).toHaveAttribute("aria-checked", "true");
  expect((await inspect(request)).counts.switcherWrites).toBe(1);
});

test("a stepper being typed in keeps what was typed while the other copy's change comes in", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Setup");
  await show(two, "Setup");
  // TSL 5.0 has a screen number, so the Screen stepper can be used.
  await one.f.locator("#sw-protocol").getByRole("radio", { name: "5.0" }).click();
  const screen = two.f.locator("#screen input");
  await expect(screen).toBeEnabled();
  await screen.click();
  await screen.press("ControlOrMeta+a");
  await two.page.keyboard.type("12");
  await toggle(one, "fsfc").click();
  await expect(toggle(two, "fsfc")).toHaveAttribute("aria-checked", "true");
  await two.page.waitForTimeout(300);
  await expect(screen).toBeFocused();
  await expect(screen).toHaveValue("12");
  await screen.press("Enter");
  await expect.poll(async () => savedSetup(request)).toMatchObject({ protocol: "5.0", fsfc: true, screen: 12 });
  await expect(one.f.locator("#screen input")).toHaveValue("12");
  await noTrouble([one, two]);
});

test("receiver settings saved in both copies at the same moment are both kept", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Setup");
  await show(two, "Setup");
  // Hubble takes a moment to restart the module, so the second save arrives while the first restarts it.
  await simulate(request, { settingsDelayMs: 400 });
  await typeBox(one, "stale", "3000");
  await typeBox(two, "sender", "127.0.0.1");
  await expect.poll(async () => (await inspect(request)).settings).toMatchObject({ staleAfterMs: 3000, sourceAddress: "127.0.0.1" });
  for (const copy of [one, two]) {
    await expect(copy.f.locator("#stale")).toHaveValue("3000");
    await expect(copy.f.locator("#sender")).toHaveValue("127.0.0.1");
    await expect(copy.f.locator("#status-line")).not.toContainText("Saving", { timeout: 12_000 });
  }
  await noTrouble([one, two]);
});

test("two copies saving at the same moment both keep their edits", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Routing");
  await show(two, "Routing");
  // Both saves wait at the workspace, so the second is made against what was saved before the first.
  await simulate(request, { holdSaves: true });
  await typeCell(one, "camera-1", "name", "Wide");
  await typeCell(two, "camera-4", "source", "40");
  await simulate(request, { releaseSaves: true });

  await expect.poll(async () => (await savedRow(request, "camera-1"))?.name).toBe("Wide");
  await expect.poll(async () => (await savedRow(request, "camera-4"))?.source).toBe(40);
  for (const copy of [one, two]) {
    await expect(cell(copy, "camera-1", "name")).toHaveText("Wide");
    await expect(cell(copy, "camera-4", "source")).toHaveText("40");
  }
  // Nothing more was written than the two edits, and no copy went round saving again and again.
  await one.page.waitForTimeout(800);
  const { counts } = await inspect(request);
  expect(counts.routingWrites).toBe(2);
  expect(counts.routingConflicts).toBeLessThanOrEqual(1);
  await noTrouble([one, two]);
});

test("the cell being typed in stays through the other copy's saves and a restart", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Routing");
  await show(two, "Routing");
  const typing = await startTyping(two, "camera-3", "name", "Close");

  // The first copy renames a camera, adds one and deletes another.
  await typeCell(one, "camera-1", "name", "Wide");
  await one.f.locator("#add-camera").click();
  await expect(one.f.locator("#routing-grid tbody tr")).toHaveCount(5);
  await cell(one, "camera-4", "name").click({ button: "right" });
  await one.f.getByRole("menuitem", { name: /Delete/ }).click();
  await expect(cell(one, "camera-4", "name")).toHaveCount(0);

  // The second copy follows all of it while its cell stays open, focused and as typed.
  await expect(cell(two, "camera-1", "name")).toHaveText("Wide");
  await expect(two.f.locator("#routing-grid tbody tr")).toHaveCount(4);
  await expect(cell(two, "camera-4", "name")).toHaveCount(0);
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("Close");

  // The first copy saves a receiver setting, which restarts the module under both copies.
  const generation = (await inspect(request)).generation;
  await show(one, "Setup");
  await typeBox(one, "stale", "5000");
  await expect.poll(async () => (await inspect(request)).settings.staleAfterMs).toBe(5000);
  expect((await inspect(request)).generation).toBeGreaterThan(generation);
  await expect.poll(() => two.page.evaluate(() => (window as unknown as { __restarts?: number }).__restarts ?? 0)).toBeGreaterThan(0);
  await two.page.waitForTimeout(500);
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("Close");

  // Typing carries on where it was, and lands without undoing anything the first copy did.
  await two.page.keyboard.type(" up");
  await two.page.keyboard.press("Enter");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.name).toBe("Close up");
  const rows = await savedRows(request);
  expect(rows.map((row) => row.name)).toEqual(["Wide", "Camera 2", "Close up", "Camera 5"]);
  await show(one, "Routing");
  await expect(cell(one, "camera-3", "name")).toHaveText("Close up");
  await noTrouble([one, two]);
});

test("a camera deleted in one copy while the other types in it is not brought back, and says so", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Routing");
  await show(two, "Routing");
  const typing = await startTyping(two, "camera-2", "name", "Gone");
  await cell(one, "camera-2", "name").click({ button: "right" });
  await one.f.getByRole("menuitem", { name: /Delete/ }).click();
  await expect.poll(async () => (await savedRows(request)).length).toBe(3);
  // The row stays under the typing until it ends.
  await two.page.waitForTimeout(600);
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("Gone");
  await two.page.keyboard.press("Enter");
  await expect(cell(two, "camera-2", "name")).toHaveCount(0);
  await expect(two.f.locator(".hubble-toast")).toContainText("deleted in another window");
  expect((await savedRows(request)).map((row) => row.id)).toEqual(["camera-1", "camera-3", "camera-4"]);
});

test("the switcher setup: both copies' changes are kept, and each copy follows the other", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Setup");
  await show(two, "Setup");
  await simulate(request, { holdSaves: true });
  await typeBox(one, "device-name", "CAM1");
  await toggle(two, "center").click();
  await simulate(request, { releaseSaves: true });
  await expect.poll(async () => savedSetup(request)).toMatchObject({ name: "CAM1", center: true });
  for (const copy of [one, two]) {
    await expect(copy.f.locator("#device-name")).toHaveValue("CAM1");
    await expect(toggle(copy, "center")).toHaveAttribute("aria-checked", "true");
  }

  // A box being typed in keeps what was typed while the other copy's change comes in.
  const name = two.f.locator("#device-name");
  await name.click();
  await name.press("ControlOrMeta+a");
  await two.page.keyboard.type("ISO");
  await toggle(one, "fsfc").click();
  await expect(toggle(two, "fsfc")).toHaveAttribute("aria-checked", "true");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("ISO");
  await name.press("Enter");
  await expect.poll(async () => savedSetup(request)).toMatchObject({ name: "ISO", center: true, fsfc: true });
  await expect(one.f.locator("#device-name")).toHaveValue("ISO");

  // A change saved by something other than the page, such as an import, shows in both.
  await simulate(request, { switcherDocument: { busName: true } });
  for (const copy of [one, two]) await expect(toggle(copy, "bus-name")).toHaveAttribute("aria-checked", "true", { timeout: 4000 });
  await noTrouble([one, two]);
});

test("the saves the page makes by itself keep the other copy's changes", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Setup");
  await show(two, "Setup");
  // The second copy changes an option while the first sends to the switcher. Sending adds the
  // device, and the first copy then saves the name the switcher knows it by, by itself.
  await simulate(request, { holdSaves: true });
  await toggle(two, "one-second").click();
  await one.f.locator("#send").click();
  await expect(one.f.locator("#device-state-text")).toContainText(/slot 3/i);
  await simulate(request, { releaseSaves: true });
  await expect.poll(async () => savedSetup(request)).toMatchObject({ device: "HUBBLE", oneSecond: true });

  // The second copy follows what the switcher now has, as read by the first, without asking it.
  await expect(two.f.locator("#device-state-text")).toContainText(/slot 3/i);
  await expect(two.f.locator("#device-grid tbody tr")).toHaveCount(4);
  await expect(toggle(one, "one-second")).toHaveAttribute("aria-checked", "true");

  // Reading the switcher takes in what it has, and keeps the change not sent yet.
  await one.f.locator("#read").click();
  await expect(one.f.locator("#status-line")).toContainText("Read the switcher");
  await one.page.waitForTimeout(500);
  expect(await savedSetup(request)).toMatchObject({ device: "HUBBLE", oneSecond: true });
  for (const copy of [one, two]) await expect(copy.f.locator("#device-state-text")).toContainText("1 change not sent");
  await noTrouble([one, two]);
});

test("a receiver setting saved in one copy shows in the other, and neither undoes the other's", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(one, "Setup");
  await show(two, "Setup");
  // The second copy is typing an allowed sender when the first copy's save restarts the module.
  const sender = two.f.locator("#sender");
  await sender.click();
  await two.page.keyboard.type("127.0.0");
  await typeBox(one, "port", "45731");
  await expect.poll(async () => (await inspect(request)).settings.port).toBe(45731);
  await expect(two.f.locator("#port")).toHaveValue("45731");
  await expect(sender).toBeFocused();
  await expect(sender).toHaveValue("127.0.0");
  await two.page.keyboard.type(".1");
  await sender.press("Enter");
  await expect.poll(async () => (await inspect(request)).settings.sourceAddress).toBe("127.0.0.1");
  expect((await inspect(request)).settings.port).toBe(45731);
  await expect(one.f.locator("#sender")).toHaveValue("127.0.0.1");
  await expect(one.f.locator("#port")).toHaveValue("45731");
  await noTrouble([one, two]);
});

test("a tab change in one copy leaves the other where it is, and saves nothing shared", async ({ page, request }) => {
  const [one, two] = await twoCopies(page, request);
  await show(two, "Routing");
  const typing = await startTyping(two, "camera-1", "name", "Crane");
  const before = (await inspect(request)).counts;
  for (const name of ["Routing", "Setup", "Tally", "Setup"] as const) await show(one, name);
  await two.page.waitForTimeout(500);
  await expect(tab(two, "Routing")).toHaveAttribute("aria-checked", "true");
  await expect(two.f.locator("#routing-view")).toBeVisible();
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("Crane");
  const after = (await inspect(request)).counts;
  expect([after.routingWrites, after.switcherWrites]).toEqual([before.routingWrites, before.switcherWrites]);
  await two.page.keyboard.press("Enter");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.name).toBe("Crane");
  await noTrouble([one, two]);
});
