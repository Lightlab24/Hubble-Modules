import { test, expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

// Undo on the Routing tab, which Hubble keeps for the grid (module-spreadsheet-history-v1), with
// real keys, clicks and the camera menu, against the real backend in tools/preview.ts. It needs
// Hubble's shared controls with grid undo: point TSL_RENDERER_ASSETS at a Hubble that has it. On an
// older Hubble the tab has no undo, as before, and these are skipped. Nothing reaches a real router.

interface Copy {
  readonly page: Page;
  readonly f: FrameLocator;
}
interface Row {
  readonly id: string;
  readonly name: string;
  readonly destination: number;
}
const UNDO = "ControlOrMeta+z";
const REDO = "ControlOrMeta+Shift+z";
const inspect = async (request: APIRequestContext) => (await request.get("/__inspect")).json();
const simulate = async (request: APIRequestContext, value: Record<string, unknown>) => {
  expect((await request.post("/__simulate", { data: value })).ok()).toBe(true);
};
const savedRows = async (request: APIRequestContext) => (await inspect(request)).routing.rows as Row[];
const savedIds = async (request: APIRequestContext) => (await savedRows(request)).map((row) => row.id);
const savedName = async (request: APIRequestContext, id: string) =>
  (await savedRows(request)).find((row) => row.id === id)?.name;

async function open(page: Page, request: APIRequestContext): Promise<Copy> {
  expect((await request.post("/__reset", { data: {} })).ok()).toBe(true);
  await page.goto("/");
  const f = page.frameLocator("iframe");
  await expect(f.locator("#loading")).toBeHidden({ timeout: 15_000 });
  const routing = f.locator("#tabs").getByRole("radio", { name: "Routing" });
  await routing.click();
  await expect(routing).toHaveAttribute("aria-checked", "true");
  return { page, f };
}
const cell = (copy: Copy, row: string, column: string) =>
  copy.f.locator(`#routing-grid td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const shownIds = (copy: Copy) =>
  copy.f.locator("#routing-grid tbody tr").evaluateAll((rows) => rows.map((row) => row.querySelector("td")?.dataset.hubbleRow));
async function typeCell(copy: Copy, row: string, column: string, text: string) {
  await cell(copy, row, column).click();
  await copy.page.keyboard.type(text);
  await copy.page.keyboard.press("Enter");
  await expect(cell(copy, row, column).locator("input.cell-input")).toHaveCount(0);
}
const failures = (copy: Copy) => copy.f.locator('.hubble-toast[data-kind="failure"]');

test.beforeEach(async ({ request }) => {
  const runtime = await (await request.get("/api/module-controls/spreadsheet-v1.js")).text();
  test.skip(!runtime.includes("historySupported"), "These shared controls have no grid undo");
});

test("typing, clearing and adding or deleting cameras undo and redo with Command+Z", async ({ page, request }) => {
  const copy = await open(page, request);
  const ids = await savedIds(request);
  expect(ids).toEqual(["camera-1", "camera-2", "camera-3", "camera-4"]);

  // Typed text: undone, redone, and saved each time.
  await typeCell(copy, "camera-2", "name", "Jib");
  await expect.poll(() => savedName(request, "camera-2")).toBe("Jib");
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, "camera-2", "name")).toHaveText("Camera 2");
  await expect.poll(() => savedName(request, "camera-2")).toBe("Camera 2");
  await copy.page.keyboard.press(REDO);
  await expect(cell(copy, "camera-2", "name")).toHaveText("Jib");
  await expect.poll(() => savedName(request, "camera-2")).toBe("Jib");

  // Delete clears a name; Undo brings it back.
  await cell(copy, "camera-3", "name").click();
  await copy.page.keyboard.press("Delete");
  await expect(cell(copy, "camera-3", "name")).toHaveText("");
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, "camera-3", "name")).toHaveText("Camera 3");

  // Add camera from the toolbar, then take it back and add it again.
  await copy.f.locator("#add-camera").click();
  await expect.poll(async () => (await savedIds(request)).length).toBe(5);
  const added = (await savedIds(request))[4]!;
  await expect(cell(copy, added, "name")).toHaveText("Camera 5");
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, added, "name")).toHaveCount(0);
  await expect.poll(() => savedIds(request)).toEqual(ids);
  await copy.page.keyboard.press(REDO);
  await expect(cell(copy, added, "name")).toHaveText("Camera 5");
  await expect.poll(() => savedIds(request)).toEqual([...ids, added]);

  // Delete a camera from its menu; Undo puts it back whole, in its place.
  await cell(copy, "camera-2", "source").click({ button: "right" });
  await copy.f.getByRole("menuitem", { name: "Delete Jib" }).click();
  await expect(cell(copy, "camera-2", "name")).toHaveCount(0);
  await expect.poll(() => savedIds(request)).toEqual(["camera-1", "camera-3", "camera-4", added]);
  await copy.f.locator("#routing-grid").focus();
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, "camera-2", "name")).toHaveText("Jib");
  expect(await shownIds(copy)).toEqual(["camera-1", "camera-2", "camera-3", "camera-4", added]);
  await expect.poll(() => savedIds(request)).toEqual(["camera-1", "camera-2", "camera-3", "camera-4", added]);
  await expect.poll(() => savedName(request, "camera-2")).toBe("Jib");
  await expect(failures(copy)).toHaveCount(0);
});

test("a refused save leaves nothing to undo, and an undo whose save is refused can be tried again", async ({ page, request }) => {
  const copy = await open(page, request);

  // The edit's save is refused: the cell goes back, and Undo has nothing of it to bring back.
  await simulate(request, { failNextSave: true });
  await typeCell(copy, "camera-4", "name", "Refused");
  await expect(failures(copy)).toHaveCount(1);
  await expect(cell(copy, "camera-4", "name")).toHaveText("Camera 4");
  await copy.f.locator("#routing-grid").focus();
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, "camera-4", "name")).toHaveText("Camera 4");

  // An edit that saves, then an undo whose save is refused: it is still there to undo.
  await typeCell(copy, "camera-1", "name", "Wide");
  await expect.poll(() => savedName(request, "camera-1")).toBe("Wide");
  await simulate(request, { failNextSave: true });
  await copy.page.keyboard.press(UNDO);
  await expect(failures(copy)).toHaveCount(2);
  await expect(cell(copy, "camera-1", "name")).toHaveText("Wide");
  await expect.poll(() => savedName(request, "camera-1")).toBe("Wide");
  await copy.f.locator("#routing-grid").focus();
  await copy.page.keyboard.press(UNDO);
  await expect(cell(copy, "camera-1", "name")).toHaveText("Camera 1");
  await expect.poll(() => savedName(request, "camera-1")).toBe("Camera 1");
});
