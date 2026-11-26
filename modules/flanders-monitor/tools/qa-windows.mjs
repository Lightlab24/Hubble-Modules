// Two copies of the real Flanders page, each in a browser page of its own as in two HubDash
// windows, on one worker. Real input goes to both. No key is pressed, so no monitor is contacted.
// Each page keeps its own focus, as a window does, so typing in one stays open while the other
// is used. (Two frames in one page would share focus, and a click in one would end the other's
// typing, as switching apps does.)
//   pnpm build && FLANDERS_PREVIEW_PORT=43292 node_modules/.bin/tsx tools/preview.ts
//   PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<Chrome for Testing> PREVIEW_ORIGIN=http://127.0.0.1:43292 node tools/qa-windows.mjs
// Checks that a copy follows the other without a reload; that a cell being typed in, and Hubble's
// choice list open on a cell, stay put and keep what was typed while the other copy adds a
// monitor above, changes the text size and edits another cell; that the same cell typed in both
// keeps the later value and says so; and that neither copy is ever refused.
import assert from "node:assert/strict";
const { chromium, expect } = await import(process.env.PLAYWRIGHT ?? "@playwright/test");
const origin = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:43292";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 700 } });
const pages = [await context.newPage(), await context.newPage()];
const errors = [];
const missing = [];
for (const page of pages) {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) missing.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
}
const saved = async () => (await (await fetch(`${origin}/__inspect`)).json()).document;
const check = (text) => console.log(`ok - ${text}`);
const [one, two] = pages.map((page) => page.frameLocator("iframe"));
const cell = (frame, row, column) => frame.locator(`#monitor-grid td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const editorIn = (frame, row, column) => cell(frame, row, column).locator("input.cell-input");
async function type(frame, row, column, value) {
  await cell(frame, row, column).dblclick();
  const input = editorIn(frame, row, column);
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press("Enter");
}
const monitorIn = async (id) => (await saved()).monitors.find((row) => row.id === id);
const shot = async (name) => {
  if (shots) for (const [index, page] of pages.entries()) await page.screenshot({ path: `${shots}/${name}-${index + 1}.png` });
};
/** The second copy adds a monitor above the first row, makes the text bigger and types a port. */
async function otherWindowSaves(port) {
  const before = (await saved()).monitors.length;
  await cell(two, "seed-1", "name").click({ button: "right" });
  await two.getByRole("menuitem", { name: "Add monitor above" }).click();
  await two.getByRole("button", { name: "Increase text size" }).click();
  await type(two, "seed-1", "port", port);
  await expect.poll(async () => {
    const doc = await saved();
    return [doc.monitors.length, doc.monitors.find((row) => row.id === "seed-1").values.port];
  }).toEqual([before + 1, port]);
}

try {
  await fetch(`${origin}/__simulate`, { method: "POST", body: JSON.stringify({ reset: true }) });
  for (const page of pages) await page.goto(origin);
  for (const frame of [one, two]) await expect(cell(frame, "seed-1", "name")).toHaveText("Grade 1", { timeout: 15_000 });
  check("both copies load and show the two monitors");

  await type(one, "seed-1", "name", "Grade A");
  await expect(cell(two, "seed-1", "name")).toHaveText("Grade A");
  check("a name typed in the first copy shows in the second without reloading it");

  // The first copy starts typing an address and leaves its editor open.
  await cell(one, "seed-2", "host").dblclick();
  const typing = editorIn(one, "seed-2", "host");
  await expect(typing).toBeFocused();
  await typing.fill("");
  await typing.pressSequentially("127.0.0.");
  const before = await typing.boundingBox();
  await otherWindowSaves("18190");
  await expect(cell(one, "seed-1", "port")).toHaveText("18190");
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("127.0.0.");
  const after = await typing.boundingBox();
  assert.ok(before && after && Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5, `the cell being typed in moved: ${JSON.stringify({ before, after })}`);
  check("the cell being typed in keeps its text, focus and place while the other copy saves");
  await shot("typing-while-other-saves");
  await typing.pressSequentially("2");
  await typing.press("Enter");
  await expect.poll(async () => (await monitorIn("seed-2")).values.host).toBe("127.0.0.2");
  await expect(cell(two, "seed-2", "host")).toHaveText("127.0.0.2");
  await expect(one.locator("#monitor-grid tbody tr")).toHaveCount(3);
  await expect(one.getByLabel("Workbook text size value")).toHaveText("14");
  check("the typed address saved, and the first copy then shows the other's new monitor and text size");

  // Hubble's choice list, open on a cell with a word typed in it, stays while the other copy saves.
  await cell(one, "seed-1", "whenInUse").click();
  await pages[0].keyboard.type("anyw");
  const list = one.locator("[data-hubble-cell-editor]");
  const search = list.locator("input");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("anyw");
  const listBefore = await list.boundingBox();
  await otherWindowSaves("18191");
  await expect(cell(one, "seed-1", "port")).toHaveText("18191");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("anyw");
  const listAfter = await list.boundingBox();
  assert.ok(listBefore && listAfter && Math.abs(listBefore.y - listAfter.y) < 0.5, `the open choice list moved: ${JSON.stringify({ listBefore, listAfter })}`);
  check("Hubble's choice list keeps its place and its search while the other copy saves");
  await shot("choosing-while-other-saves");
  await search.press("Enter");
  await expect.poll(async () => (await monitorIn("seed-1")).values.whenInUse).toBe("send");
  await expect(cell(two, "seed-1", "whenInUse")).toHaveText("Send anyway");
  await expect(one.locator("#monitor-grid tbody tr")).toHaveCount(4);
  await expect(one.getByLabel("Workbook text size value")).toHaveText("15");
  check("the choice saved, and the first copy then shows what waited");

  // The same cell in both: the later value is kept, and the copy that typed it is told.
  await cell(one, "seed-2", "port").dblclick();
  const clash = editorIn(one, "seed-2", "port");
  await expect(clash).toBeFocused();
  await type(two, "seed-2", "port", "18200");
  await expect.poll(async () => (await monitorIn("seed-2")).values.port).toBe("18200");
  await clash.fill("18201");
  await clash.press("Enter");
  await expect.poll(async () => (await monitorIn("seed-2")).values.port).toBe("18201");
  await expect(cell(two, "seed-2", "port")).toHaveText("18201");
  await expect(one.locator("#error")).toHaveText("Client's Port was also changed in another window. What you entered here is kept.");
  await expect(one.locator("#error")).toHaveAttribute("data-tone", "note");
  check("the same cell typed in both copies keeps the later value, and that copy says so");

  await expect(two.locator("#error")).toBeHidden();
  for (const frame of [one, two]) await expect(frame.locator("#save-status")).toHaveText("Workspace saved");
  check("neither copy shows a refusal, and both say the workspace is saved");
  assert.deepEqual(errors, []);
  check("no page errors");
  console.log(missing.length ? `note - files not found: ${[...new Set(missing)].join(", ")}` : "ok - every file loaded");
} finally {
  await browser.close();
}
