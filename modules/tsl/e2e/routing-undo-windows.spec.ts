import { test, expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

// Undo on the Routing tab with the page open in several windows, and the steps it is careful
// with: what each step holds, refused values and saves, and an older Hubble. Real key presses,
// clicks and the camera menu go to the built page in the same sandboxed frame Hubble gives it,
// against the real backend in tools/preview.ts with its pretend switcher and router. Nothing here
// reaches a real switcher or router. routing-undo.spec.ts has the first checks of undo itself.
//
// The shared grid controls come from TSL_RENDERER_ASSETS. With a Hubble that keeps grid undo, the
// undo checks run; with an earlier one, only the check that the tab works as before without it.

interface Copy {
  readonly page: Page;
  readonly f: FrameLocator;
}
const inspect = async (request: APIRequestContext) => (await request.get("/__inspect")).json();
const simulate = async (request: APIRequestContext, value: Record<string, unknown>) => {
  expect((await request.post("/__simulate", { data: value })).ok()).toBe(true);
};
type Saved = { id: string; name: string; enabled: boolean; address: number; source: number; indicator: string };
const savedRows = async (request: APIRequestContext) => (await inspect(request)).routing.rows as Saved[];
const savedRow = async (request: APIRequestContext, id: string) => (await savedRows(request)).find((row) => row.id === id);
const savedIds = async (request: APIRequestContext) => (await savedRows(request)).map((row) => row.id);
/** Whether the shared grid controls served here keep undo. */
const keepsUndo = async (request: APIRequestContext) =>
  (await (await request.get("/api/module-controls/spreadsheet-v1.js")).text()).includes("historySupported");

async function open(page: Page): Promise<Copy> {
  await page.goto("/");
  const f = page.frameLocator("iframe");
  await expect(f.locator("#loading")).toBeHidden({ timeout: 15_000 });
  await f.locator("#tabs").getByRole("radio", { name: "Routing" }).click();
  await expect(f.locator("#routing-grid")).toBeVisible();
  return { page, f };
}
/** Copies of the page on one freshly started module, as HubDash windows. */
async function copies(page: Page, request: APIRequestContext, count: number): Promise<Copy[]> {
  expect((await request.post("/__reset", { data: {} })).ok()).toBe(true);
  const opened = [await open(page)];
  while (opened.length < count) opened.push(await open(await page.context().newPage()));
  return opened;
}
const cell = (copy: Copy, row: string, column: string) =>
  copy.f.locator(`#routing-grid td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
/** Real key presses into a camera cell, then Enter. */
async function typeCell(copy: Copy, row: string, column: string, text: string) {
  await cell(copy, row, column).click();
  await copy.page.keyboard.type(text);
  const input = cell(copy, row, column).locator("input.cell-input");
  await expect(input).toHaveValue(text);
  await copy.page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
}
const undo = (copy: Copy) => copy.page.keyboard.press("ControlOrMeta+z");
const redo = (copy: Copy) => copy.page.keyboard.press("ControlOrMeta+Shift+z");
const failures = (copy: Copy) => copy.f.locator('.hubble-toast[data-kind="failure"]');
/** The fading failure toast goes by itself; checks wait for it so the next one starts clean. */
async function toastSays(copy: Copy, text: string | RegExp) {
  await expect(failures(copy).last()).toContainText(text);
  await expect(failures(copy)).toHaveCount(0, { timeout: 15_000 });
}

test("Delete, Enabled and a list pick undo and redo, and Redo of a Delete leaves the numbers alone", async ({ page, request }) => {
  test.skip(!(await keepsUndo(request)), "This Hubble keeps no grid undo");
  const [one] = (await copies(page, request, 1)) as [Copy];

  // Space on Enabled.
  await cell(one, "camera-3", "enabled").click();
  await one.page.keyboard.press("Space");
  await expect(cell(one, "camera-3", "enabled")).toHaveText("");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.enabled).toBe(false);
  await undo(one);
  await expect(cell(one, "camera-3", "enabled")).toHaveText("✓");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.enabled).toBe(true);

  // Delete over a name, Enabled and an address: the number stays, as Delete always leaves it.
  await cell(one, "camera-1", "name").click();
  await cell(one, "camera-1", "address").click({ modifiers: ["Shift"] });
  await one.page.keyboard.press("Delete");
  await expect(cell(one, "camera-1", "name")).toHaveText("");
  await expect(cell(one, "camera-1", "enabled")).toHaveText("");
  await expect(cell(one, "camera-1", "address")).toHaveText("1");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.name).toBe("");
  await undo(one);
  await expect(cell(one, "camera-1", "name")).toHaveText("Camera 1");
  await expect(cell(one, "camera-1", "enabled")).toHaveText("✓");
  // Undo selects what it put back.
  await expect(cell(one, "camera-1", "name")).toHaveAttribute("data-hubble-spreadsheet-selected", "true");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.name).toBe("Camera 1");
  // Redo clears them again, and still leaves the number alone, without a complaint.
  await redo(one);
  await expect(cell(one, "camera-1", "name")).toHaveText("");
  await expect(cell(one, "camera-1", "address")).toHaveText("1");
  await expect.poll(async () => await savedRow(request, "camera-1")).toMatchObject({ name: "", enabled: false, address: 1 });
  await undo(one);
  await expect(cell(one, "camera-1", "name")).toHaveText("Camera 1");

  // A pick from Hubble's list on the on-air lamp.
  await cell(one, "camera-4", "indicator").click();
  await one.page.keyboard.press("Enter");
  await one.f.getByRole("option", { name: "Tally 1", exact: true }).click();
  await expect(cell(one, "camera-4", "indicator")).toHaveText("Tally 1");
  await expect.poll(async () => (await savedRow(request, "camera-4"))?.indicator).toBe("flag1");
  await undo(one);
  await expect(cell(one, "camera-4", "indicator")).toHaveText("Default");
  await expect.poll(async () => (await savedRow(request, "camera-4"))?.indicator).toBe("default");
  expect(await savedRows(request)).toMatchObject([
    { name: "Camera 1", enabled: true, address: 1 },
    { name: "Camera 2" },
    { name: "Camera 3", enabled: true },
    { name: "Camera 4", indicator: "default" },
  ]);
  await expect(failures(one)).toHaveCount(0);
});

test("a value refused here is no step, and after a refused save the step before it is undone as usual", async ({ page, request }) => {
  test.skip(!(await keepsUndo(request)), "This Hubble keeps no grid undo");
  const [one] = (await copies(page, request, 1)) as [Copy];

  await typeCell(one, "camera-2", "source", "40");
  await expect.poll(async () => (await savedRow(request, "camera-2"))?.source).toBe(40);
  // A value the tab refuses changes nothing and leaves nothing to undo.
  await typeCell(one, "camera-2", "address", "abc");
  await toastSays(one, "Address is a whole number");
  await expect(cell(one, "camera-2", "address")).toHaveText("2");
  await undo(one);
  await expect(cell(one, "camera-2", "source")).toHaveText("22");
  await expect.poll(async () => (await savedRow(request, "camera-2"))?.source).toBe(22);

  // A save the workspace refuses puts the cell back, its step goes, and the step before it is
  // still this window's own: Undo puts it back, with no word of another window.
  await typeCell(one, "camera-3", "name", "Crane");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.name).toBe("Crane");
  await simulate(request, { failNextSave: true });
  await typeCell(one, "camera-3", "name", "Dolly");
  await toastSays(one, "The workspace refused this save");
  await expect(cell(one, "camera-3", "name")).toHaveText("Crane");
  await undo(one);
  await expect(cell(one, "camera-3", "name")).toHaveText("Camera 3");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.name).toBe("Camera 3");

  // A refused Undo goes back where it was, and so does what this window holds in the cell.
  await redo(one);
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.name).toBe("Crane");
  await simulate(request, { failNextSave: true });
  await undo(one);
  await toastSays(one, "The workspace refused this save");
  await expect(cell(one, "camera-3", "name")).toHaveText("Crane");
  await undo(one);
  await expect(cell(one, "camera-3", "name")).toHaveText("Camera 3");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.name).toBe("Camera 3");
  await expect(failures(one)).toHaveCount(0);
});

test("an Undo in one window shows in the other at once, and never undoes the other window's cell", async ({ page, request }) => {
  test.skip(!(await keepsUndo(request)), "This Hubble keeps no grid undo");
  const [one, two] = (await copies(page, request, 2)) as [Copy, Copy];

  await typeCell(one, "camera-1", "source", "31");
  await expect(cell(two, "camera-1", "source")).toHaveText("31");
  await undo(one);
  await expect(cell(one, "camera-1", "source")).toHaveText("21");
  await expect(cell(two, "camera-1", "source")).toHaveText("21");
  await redo(one);
  await expect(cell(two, "camera-1", "source")).toHaveText("31");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.source).toBe(31);

  // The other window changes the same cell, and this window's Undo leaves it, and says so.
  await typeCell(two, "camera-1", "source", "50");
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  await undo(one);
  await toastSays(one, "Camera 1's Source was changed in another window since, so it was left as it is");
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  await expect(cell(two, "camera-1", "source")).toHaveText("50");
  expect((await savedRow(request, "camera-1"))?.source).toBe(50);

  // A change of this window's own made after it is undone as usual, in both windows.
  await typeCell(one, "camera-1", "source", "60");
  await expect(cell(two, "camera-1", "source")).toHaveText("60");
  await undo(one);
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  await expect(cell(two, "camera-1", "source")).toHaveText("50");
  // The cell holds again what the other window left, so its own Undo puts back what it did.
  await undo(two);
  await expect(cell(two, "camera-1", "source")).toHaveText("31");
  await expect(cell(one, "camera-1", "source")).toHaveText("31");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.source).toBe(31);
  await expect(failures(two)).toHaveCount(0);
});

test("with Hubble's own check, an older step is left too after this window typed over the other window's value", async ({ page, request }) => {
  const runtime = await (await request.get("/api/module-controls/spreadsheet-v1.js")).text();
  test.skip(!runtime.includes("onHistoryLeft"), "This Hubble's grid undo doesn't check for changes made since");
  const [one, two] = (await copies(page, request, 2)) as [Copy, Copy];

  await typeCell(one, "camera-1", "source", "31");
  await expect(cell(two, "camera-1", "source")).toHaveText("31");
  await typeCell(two, "camera-1", "source", "50");
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  // This window types over it and undoes that, which puts back the other window's 50.
  await typeCell(one, "camera-1", "source", "60");
  await expect(cell(two, "camera-1", "source")).toHaveText("60");
  await undo(one);
  await expect(cell(two, "camera-1", "source")).toHaveText("50");
  // The step before left 31; the cell holds the other window's 50, so it stays, in this page's words.
  await undo(one);
  await toastSays(one, "Camera 1's Source was changed in another window since, so it was left as it is");
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  await expect(cell(two, "camera-1", "source")).toHaveText("50");
  expect((await savedRow(request, "camera-1"))?.source).toBe(50);
});

test("a camera added in one window and changed in another stays through the first window's Undo", async ({ page, request }) => {
  test.skip(!(await keepsUndo(request)), "This Hubble keeps no grid undo");
  const [one, two] = (await copies(page, request, 2)) as [Copy, Copy];

  await one.f.locator("#add-camera").click();
  await expect.poll(async () => (await savedIds(request)).length).toBe(5);
  const added = (await savedIds(request))[4]!;
  await expect(cell(two, added, "name")).toHaveText("Camera 5");
  await typeCell(two, added, "name", "Crane");
  await expect(cell(one, added, "name")).toHaveText("Crane");
  await one.f.locator("#routing-grid").focus();
  await undo(one);
  await toastSays(one, "Crane was changed in another window since, so it was left as it is");
  await expect(cell(one, added, "name")).toHaveText("Crane");
  await expect(cell(two, added, "name")).toHaveText("Crane");
  expect(await savedIds(request)).toContain(added);

  // Deleted in this window and put back with Undo: both windows show it gone, then back.
  await cell(one, "camera-2", "source").click({ button: "right" });
  await one.f.getByRole("menuitem", { name: "Delete Camera 2" }).click();
  await expect(cell(two, "camera-2", "name")).toHaveCount(0);
  await one.f.locator("#routing-grid").focus();
  await undo(one);
  await expect(cell(one, "camera-2", "name")).toHaveText("Camera 2");
  await expect(cell(two, "camera-2", "name")).toHaveText("Camera 2");
  await expect.poll(() => savedIds(request)).toEqual(["camera-1", "camera-2", "camera-3", "camera-4", added]);
  // Redo takes it away again only as this window put it back: unchanged, it goes from both.
  await redo(one);
  await expect(cell(two, "camera-2", "name")).toHaveCount(0);
  await expect.poll(() => savedIds(request)).toEqual(["camera-1", "camera-3", "camera-4", added]);
});

test("an Undo of a cell saved elsewhere a moment ago, before this window heard of it, is left as saved", async ({ page, request }) => {
  test.skip(!(await keepsUndo(request)), "This Hubble keeps no grid undo");
  const [one] = (await copies(page, request, 1)) as [Copy];
  await typeCell(one, "camera-1", "source", "31");
  await expect.poll(async () => (await savedRow(request, "camera-1"))?.source).toBe(31);
  // Saved by something other than this window, and Undo pressed straight after.
  const rows = await savedRows(request);
  await simulate(request, { routingRows: rows.map((row) => (row.id === "camera-1" ? { ...row, source: 50 } : row)) });
  await undo(one);
  await toastSays(one, "Camera 1's Source was changed in another window since, so it was left as it is");
  await expect(cell(one, "camera-1", "source")).toHaveText("50");
  expect((await savedRow(request, "camera-1"))?.source).toBe(50);
});

test("on a Hubble without grid undo the tab works as before, and Command+Z changes nothing", async ({ page, request }) => {
  test.skip(await keepsUndo(request), "This Hubble keeps grid undo");
  const [one] = (await copies(page, request, 1)) as [Copy];
  await typeCell(one, "camera-2", "name", "Jib");
  await expect.poll(async () => (await savedRow(request, "camera-2"))?.name).toBe("Jib");
  await cell(one, "camera-3", "enabled").click();
  await one.page.keyboard.press("Space");
  await expect.poll(async () => (await savedRow(request, "camera-3"))?.enabled).toBe(false);
  await one.f.locator("#add-camera").click();
  await expect.poll(async () => (await savedIds(request)).length).toBe(5);
  await undo(one);
  await redo(one);
  await expect(cell(one, "camera-2", "name")).toHaveText("Jib");
  await expect(cell(one, "camera-3", "enabled")).toHaveText("");
  expect(await savedRow(request, "camera-2")).toMatchObject({ name: "Jib" });
  expect(await savedRow(request, "camera-3")).toMatchObject({ enabled: false });
  expect(await savedIds(request)).toHaveLength(5);
  await expect(failures(one)).toHaveCount(0);
});
