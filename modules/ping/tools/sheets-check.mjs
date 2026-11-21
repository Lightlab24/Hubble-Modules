// Checks sheets with real input against a running `PING_PREVIEW_FAKE=1 pnpm preview` started with
// PING_PREVIEW_DEVICES="Core switch=10.192.54.1,Router=10.192.54.20,Camera A=10.192.60.11,Camera B=10.192.60.12,RIO 1=10.192.70.5,Spare=192.0.2.1"
// and nothing saved yet: adding, renaming, moving rows to a sheet, reordering and removing sheets,
// a held save with a second edit, a failed save, Undo, and that the timeline never moves.
// Run it from a folder that has @playwright/test. Screenshots go to the folder given, or /tmp.
import { createRequire } from "node:module";
// Playwright comes from the folder it is run in, as this module doesn't carry it.
const { chromium } = createRequire(`${process.cwd()}/`)("@playwright/test");
const shots = process.argv[2] || "/tmp";
const base = "http://127.0.0.1:43191";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};
const doc = async () => (await (await fetch(`${base}/__inspect`)).json()).document;
const simulate = (body) => fetch(`${base}/__simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const names = (d) => (d.sheets ?? [{ id: "devices", name: "Devices" }]).map((sheet) => sheet.name);
const onSheet = (d, name) => {
  const sheets = d.sheets ?? [{ id: "devices", name: "Devices" }];
  const id = sheets.find((sheet) => sheet.name === name)?.id;
  return d.devices.filter((row) => (sheets.some((sheet) => sheet.id === row.sheetId) ? row.sheetId : sheets[0].id) === id).map((row) => row.values.name);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
await page.goto(base);
const frame = page.frameLocator("iframe");
await frame.locator("#loading").waitFor({ state: "hidden" });
const f = page.frames().find((item) => item !== page.mainFrame());
await page.waitForTimeout(1200);

const tabs = async () => (await f.evaluate(() => [...document.querySelectorAll("#sheet-tabs [role=tab]")].map((tab) => tab.textContent.trim())));
const gridNames = async () => f.evaluate(() => [...document.querySelectorAll("#device-grid tbody td[data-column-id=name]")].map((cell) => cell.textContent.trim()));
const timelineTop = async () => Math.round((await frame.locator("section.timeline").boundingBox()).y);
const tab = (name) => frame.getByRole("tab", { name: new RegExp(`^${name}`) });
async function newSheet(name) {
  await frame.getByRole("button", { name: "Add sheet" }).click();
  const input = frame.getByRole("textbox", { name: "Sheet name" });
  await input.fill(name);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
}
async function menu(sheet, item) {
  await frame.getByRole("button", { name: `${sheet} options` }).click();
  await frame.getByRole("menuitem", { name: item }).click();
  await page.waitForTimeout(250);
}

const top = await timelineTop();
check("One sheet, Devices, holds the six devices from before sheets", JSON.stringify(await tabs()) === '["Devices6"]' && (await gridNames()).length === 6, JSON.stringify(await tabs()));

// 1. A new sheet shows and opens at once while its save is held; a device added before it lands goes on it.
await simulate({ holdSaves: true });
await newSheet("Cameras");
const heldTabs = await tabs();
const heldEmpty = await frame.locator("#empty").isVisible();
const heldTitle = await frame.locator("#empty-title").textContent();
check("A new sheet appears and opens while its save is held", JSON.stringify(heldTabs) === '["Devices6","Cameras0"]' && heldEmpty && heldTitle === "No devices on this sheet" && !(await doc()).sheets, `${JSON.stringify(heldTabs)}, "${heldTitle}"`);
await frame.locator("#empty-add").click();
await page.waitForTimeout(250);
check("Adding a device to it works before the first save lands", (await gridNames()).length === 1 && JSON.stringify(await tabs()) === '["Devices6","Cameras1"]' && (await frame.locator("#device-count").inputValue()) === "1");
await simulate({ releaseSaves: true });
await page.waitForTimeout(800);
let d = await doc();
check("Both land: the sheet, then its device", JSON.stringify(names(d)) === '["Devices","Cameras"]' && onSheet(d, "Cameras").length === 1, `${JSON.stringify(names(d))}, Cameras ${JSON.stringify(onSheet(d, "Cameras"))}`);
check("The timeline didn't move", (await timelineTop()) === top);
await page.keyboard.press("Escape");
// Take the blank device back off, with the Devices box.
const box = frame.locator("#device-count");
await box.fill("0"); await box.press("Enter"); await page.waitForTimeout(400);

// 2. Move Camera A and B there by selecting their rows.
await tab("Devices").click(); await page.waitForTimeout(300);
check("Switching sheets shows that sheet's devices", (await gridNames()).length === 6 && (await timelineTop()) === top);
await frame.locator('th.row-number[aria-label="Camera A"]').click();
await frame.locator('th.row-number[aria-label="Camera B"]').click({ modifiers: ["Shift"] });
await page.waitForTimeout(200);
const mover = frame.getByRole("combobox", { name: "Move selected rows to sheet" });
check("Selecting rows offers Move selected rows… on the tabs line, without moving the timeline", (await mover.isVisible()) && (await timelineTop()) === top);
await mover.selectOption({ label: "Cameras" });
await page.waitForTimeout(400);
d = await doc();
check("Camera A and B move to Cameras", JSON.stringify(onSheet(d, "Cameras")) === '["Camera A","Camera B"]' && (await gridNames()).length === 4, JSON.stringify(await tabs()));

// 3. Rename from the tab menu.
await menu("Cameras", "Rename sheet…");
const rename = frame.getByRole("textbox", { name: "Sheet name" });
await rename.fill("Cameras on set"); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
check("Rename sheet… renames it", JSON.stringify(names(await doc())) === '["Devices","Cameras on set"]');

// 4. A failed save takes the new sheet back off and says so.
await simulate({ failNextSave: true });
await newSheet("RIO");
await page.waitForTimeout(900);
check("A failed save takes the new sheet back off and says so", JSON.stringify(names(await doc())) === '["Devices","Cameras on set"]' && !(await tabs()).some((name) => name.startsWith("RIO")) && /refused/u.test(await f.evaluate(() => document.body.innerText)), JSON.stringify(await tabs()));

// 5. RIO for real, with RIO 1 on it.
await newSheet("RIO");
await tab("Devices").click(); await page.waitForTimeout(300);
await frame.locator('th.row-number[aria-label="RIO 1"]').click(); await page.waitForTimeout(200);
await mover.selectOption({ label: "RIO" }); await page.waitForTimeout(400);
d = await doc();
check("RIO holds RIO 1", JSON.stringify(onSheet(d, "RIO")) === '["RIO 1"]' && JSON.stringify(onSheet(d, "Devices")) === '["Core switch","Router","Spare"]');

// 6. Reorder: Devices to the end from its menu, then drag RIO to the front.
await menu("Devices", "Move sheet to end");
check("Move sheet to end puts Devices last", JSON.stringify(names(await doc())) === '["Cameras on set","RIO","Devices"]');
await tab("RIO").dragTo(tab("Cameras on set"));
await page.waitForTimeout(400);
check("Dragging RIO before Cameras on set reorders them", JSON.stringify(names(await doc())) === '["RIO","Cameras on set","Devices"]', JSON.stringify(names(await doc())));
d = await doc();
check("Reordering moved no device", JSON.stringify(onSheet(d, "Devices")) === '["Core switch","Router","Spare"]' && JSON.stringify(onSheet(d, "RIO")) === '["RIO 1"]');

// 7. The timeline follows the open sheet.
await tab("Cameras on set").click(); await page.waitForTimeout(600);
check("The timeline shows a device on the open sheet", /^Camera [AB]$/u.test(await frame.locator("#tl-name").textContent()), await frame.locator("#tl-name").textContent());

// 8. Removing a sheet with a filled-in device asks first; Undo brings both back.
await menu("RIO", "Remove sheet");
const dialog = frame.getByRole("alertdialog").or(frame.getByRole("dialog")).filter({ hasText: "Remove the RIO sheet?" });
const asked = await dialog.isVisible();
await frame.getByRole("button", { name: "Remove sheet" }).last().click();
await page.waitForTimeout(500);
d = await doc();
check("Remove sheet names RIO 1, then takes the sheet and RIO 1 off", asked && JSON.stringify(names(d)) === '["Cameras on set","Devices"]' && !d.devices.some((row) => row.values.name === "RIO 1"));
await frame.locator("#device-grid tbody td[data-column-id=name]").first().click();
await page.keyboard.press("Meta+z"); await page.waitForTimeout(600);
d = await doc();
check("⌘Z brings RIO and RIO 1 back", JSON.stringify(names(d)) === '["RIO","Cameras on set","Devices"]' && JSON.stringify(onSheet(d, "RIO")) === '["RIO 1"]', JSON.stringify(names(d)));
check("The header still counts every sheet's devices", /of 6 online/u.test(await frame.locator("#fleet-status").textContent()), await frame.locator("#fleet-status").textContent());
check("The timeline never moved", (await timelineTop()) === top);
check("No errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
await page.screenshot({ path: `${shots}/ping-0.1.8-sheets.png` });
await browser.close();
const failed = results.filter((item) => !item.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
