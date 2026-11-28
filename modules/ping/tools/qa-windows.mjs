// Two copies of the real Ping page, each in a browser page of its own as in two HubDash windows,
// on one worker. Real input goes to both; nothing is pinged (PING_PREVIEW_FAKE) and only TEST-NET
// addresses are typed. Each page keeps its own focus, as a window does, so typing in one stays
// open while the other is used. (Two frames in one page would share focus, and a click in one
// would end the other's typing, as switching apps does.)
//   pnpm build && PING_PREVIEW_FAKE=1 PING_PREVIEW_PORT=43291 npx tsx tools/preview.ts
//   PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<Chrome for Testing> PREVIEW_ORIGIN=http://127.0.0.1:43291 node tools/qa-windows.mjs
// Checks that a copy follows the other's devices, columns and text size without a reload, that the
// cell being typed in one copy stays put and keeps its text while the other adds a row above it,
// hides a column, changes the text size and renames another device, that the same cell typed in
// both keeps the later value and says so, that each copy keeps its own sheet, Show last and scale
// (place.ts), that a page opens where one was last left, and that neither copy is ever refused.
import assert from "node:assert/strict";
const { chromium, expect } = await import(process.env.PLAYWRIGHT ?? "@playwright/test");
const origin = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:43291";
const shots = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
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
const one = pages[0].frameLocator("iframe");
const two = pages[1].frameLocator("iframe");
const cell = (frame, row, column) => frame.locator(`#device-grid td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const editorIn = (frame, row, column) => cell(frame, row, column).locator("input.cell-input");
async function type(frame, row, column, value) {
  await cell(frame, row, column).dblclick();
  const input = editorIn(frame, row, column);
  await expect(input).toBeFocused();
  await input.fill(value);
  await input.press("Enter");
}
const deviceIn = async (id) => (await saved()).devices.find((row) => row.id === id);
const shot = async (name) => {
  if (shots) for (const [index, page] of pages.entries()) await page.screenshot({ path: `${shots}/${name}-${index + 1}.png` });
};
/** Every message a copy shows over its page, from Hubble's toasts, leaving out ones that are hidden. */
const toasts = (frame) => frame.locator("[data-hubble-toast]:visible, .hubble-toast:visible, [role=status]:visible, [role=alert]:visible").allInnerTexts();

try {
  await fetch(`${origin}/__simulate`, { method: "POST", body: JSON.stringify({ reset: true }) });
  for (const page of pages) await page.goto(origin);
  for (const frame of [one, two]) await expect(cell(frame, "seed-1", "name")).toHaveText("This Mac", { timeout: 15_000 });
  check("both copies load and show the two devices");

  await type(one, "seed-2", "name", "Spare router");
  await expect(cell(two, "seed-2", "name")).toHaveText("Spare router");
  assert.equal((await deviceIn("seed-2")).values.name, "Spare router");
  check("a name typed in the first copy shows in the second without reloading it");

  // The first copy starts typing an address and leaves its editor open.
  await cell(one, "seed-2", "host").dblclick();
  const typing = editorIn(one, "seed-2", "host");
  await expect(typing).toBeFocused();
  await typing.fill("");
  await typing.pressSequentially("192.0.2.");
  const before = await typing.boundingBox();

  // Meanwhile the second copy adds a device above it, hides a column, changes the text size and
  // its own Show last, and renames the other device.
  await cell(two, "seed-1", "name").click({ button: "right" });
  await two.getByRole("menuitem", { name: "Add device above" }).click();
  await two.locator('#device-grid th[data-column-id="average"]').click({ button: "right" });
  await two.getByRole("menuitem", { name: "Hide column" }).click();
  await two.getByRole("button", { name: "Increase text size" }).click();
  await two.getByRole("radio", { name: "1 hr" }).click();
  await type(two, "seed-1", "name", "Studio Mac");
  await expect.poll(async () => {
    const doc = await saved();
    return [doc.devices.length, doc.view.hidden.includes("average"), doc.view.textSize, doc.view.span, doc.devices.find((row) => row.id === "seed-1").values.name];
  }).toEqual([3, true, 14, "10m", "Studio Mac"]);
  check("the second copy's row, column, text size and name saved; its Show last is its own");

  // The first copy's other cells follow while it types, but its cell stays where it was, with its text.
  await expect(cell(one, "seed-1", "name")).toHaveText("Studio Mac");
  await expect(typing).toBeFocused();
  await expect(typing).toHaveValue("192.0.2.");
  const after = await typing.boundingBox();
  assert.ok(before && after && Math.abs(before.x - after.x) < 0.5 && Math.abs(before.y - after.y) < 0.5, `the cell being typed in moved: ${JSON.stringify({ before, after })}`);
  check("the cell being typed in keeps its text, focus and place while the other copy saves");
  await shot("typing-while-other-saves");

  await typing.pressSequentially("55");
  await typing.press("Enter");
  await expect.poll(async () => (await deviceIn("seed-2")).values.host).toBe("192.0.2.55");
  await expect(cell(two, "seed-2", "host")).toHaveText("192.0.2.55");
  // Now the first copy draws what waited: the new row above, the hidden column, the text size.
  await expect(one.locator("#device-grid tbody tr")).toHaveCount(3);
  await expect(one.locator('#device-grid th[data-column-id="average"]')).toHaveCount(0);
  await expect(one.getByLabel("Workbook text size value")).toHaveText("14");
  check("the typed address saved, and the first copy then shows the second's devices, columns and text size");
  // Show last stays as each copy chose it.
  await expect(one.getByRole("radio", { name: "10 min" })).toHaveAttribute("aria-checked", "true");
  await expect(one.locator('#device-grid th[data-column-id="strip"]')).toHaveText("Last 10 Min");
  await expect(two.getByRole("radio", { name: "1 hr" })).toHaveAttribute("aria-checked", "true");
  await expect(two.locator('#device-grid th[data-column-id="strip"]')).toHaveText("Last 1 Hr");
  check("the first copy still shows the last 10 minutes while the second shows the last hour");
  await shot("after-typing");

  // The same cell in both: the later value is kept, and the copy that typed it is told.
  await cell(one, "seed-1", "host").dblclick();
  const clash = editorIn(one, "seed-1", "host");
  await expect(clash).toBeFocused();
  await type(two, "seed-1", "host", "192.0.2.77");
  await expect.poll(async () => (await deviceIn("seed-1")).values.host).toBe("192.0.2.77");
  await expect(clash).toHaveValue("127.0.0.1");
  await clash.fill("192.0.2.88");
  await clash.press("Enter");
  await expect.poll(async () => (await deviceIn("seed-1")).values.host).toBe("192.0.2.88");
  await expect(cell(two, "seed-1", "host")).toHaveText("192.0.2.88");
  await expect(one.getByText("Studio Mac's IP Address was also changed in another window")).toBeVisible();
  check("the same cell typed in both copies keeps the later value, and that copy says so");

  // The sheets are shared, and which one is open is each copy's own.
  await two.getByRole("button", { name: "Add sheet" }).click();
  await two.getByRole("dialog").getByRole("button", { name: "Create sheet" }).click();
  await expect(two.getByRole("tab", { name: /Sheet 1/ })).toHaveAttribute("aria-selected", "true");
  await expect(one.getByRole("tab", { name: /Sheet 1/ })).toHaveAttribute("aria-selected", "false");
  await expect(one.getByRole("tab", { name: /Devices/ })).toHaveAttribute("aria-selected", "true");
  await expect(one.locator("#device-grid tbody tr")).toHaveCount(3);
  check("a sheet added in the second copy opens there, and the first copy stays on Devices with the new tab beside it");
  await one.getByRole("tab", { name: /Sheet 1/ }).click();
  await two.getByRole("tab", { name: /Devices/ }).click();
  await expect(one.getByRole("tab", { name: /Sheet 1/ })).toHaveAttribute("aria-selected", "true");
  await expect(two.getByRole("tab", { name: /Devices/ })).toHaveAttribute("aria-selected", "true");
  await expect(one.locator("#empty")).toBeVisible();
  await expect(two.locator("#device-grid tbody tr")).toHaveCount(3);
  check("each copy switches sheets without moving the other");

  // The timeline scale is each copy's own too.
  const scaleBox = (frame) => frame.locator("#scale .hubble-stepper-input");
  await expect(one.locator("#scale-auto")).toHaveAttribute("aria-pressed", "true");
  await scaleBox(two).click();
  await scaleBox(two).press("Meta+a");
  await scaleBox(two).pressSequentially("4");
  await scaleBox(two).press("Enter");
  await expect(two.locator("#scale-auto")).toHaveAttribute("aria-pressed", "false");
  await expect(scaleBox(two)).toHaveValue("4.0");
  await pages[0].waitForTimeout(600);
  await expect(one.locator("#scale-auto")).toHaveAttribute("aria-pressed", "true");
  check("a scale set in the second copy leaves the first on Auto");
  const doc = await saved();
  assert.deepEqual([doc.view.span, doc.view.sheetId, doc.view.scaleMs], ["10m", undefined, undefined]);
  check("no copy saved its sheet, Show last or scale with the list");
  await shot("each-copy-its-own-view");

  // A page opens where one was last left: the second copy, on Devices, the last hour, 4 ms.
  await pages[0].reload();
  await expect(one.locator("#loading")).toBeHidden({ timeout: 15_000 });
  await expect(one.getByRole("tab", { name: /Devices/ })).toHaveAttribute("aria-selected", "true");
  await expect(one.getByRole("radio", { name: "1 hr" })).toHaveAttribute("aria-checked", "true");
  await expect(scaleBox(one)).toHaveValue("4.0");
  check("a reloaded copy opens where the page was last left");

  for (const frame of [one, two]) await expect(frame.locator("#save-status")).toHaveText("All changes saved");
  const messages = [...(await toasts(one)), ...(await toasts(two))].join("\n");
  assert.doesNotMatch(messages, /refused|changed before|was removed|left as it is|Couldn't|can't/i, messages);
  check("neither copy shows a refusal, and both say all changes are saved");
  assert.deepEqual(errors, []);
  check("no page errors");
  console.log(missing.length ? `note - files not found: ${[...new Set(missing)].join(", ")}` : "ok - every file loaded");
} finally {
  await browser.close();
}
