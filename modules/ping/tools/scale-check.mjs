// Checks the timeline's Scale with real input against a running `PING_PREVIEW_FAKE=1 pnpm preview`
// whose first device answers: the Scale list, caps, hover, a held and a failed save, pinching over
// the ms numbers, double-click for Auto, Undo, and that nothing on the right of the row ever moves.
// Run it from a folder that has @playwright/test. Screenshots go to the folder given, or /tmp.
import { createRequire } from "node:module";
// Playwright comes from the folder it is run in, as this module doesn't carry it.
const { chromium } = createRequire(`${process.cwd()}/`)("@playwright/test");
const shots = process.argv[2] || "/tmp";
const base = "http://127.0.0.1:43191";
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const saved = async () => (await (await fetch(`${base}/__inspect`)).json()).document.view.scaleMs ?? "auto";
const simulate = (body) => fetch(`${base}/__simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
await page.goto(base);
const frame = page.frameLocator("iframe");
await frame.locator("#loading").waitFor({ state: "hidden" });
const f = page.frames().find((item) => item !== page.mainFrame());
await page.waitForTimeout(800);
// The user's device has no Alert Over of its own.
const over = frame.locator('td[data-row-id="seed-1"][data-column-id="over"]');
if ((await over.textContent()).trim()) { await over.click(); await page.keyboard.press("Backspace"); }
await frame.locator('td[data-row-id="seed-1"][data-column-id="name"]').click();
await page.waitForTimeout(1200);

const chart = await frame.locator("#chart").boundingBox();
const numbers = { x: chart.x + 20, y: chart.y + 80 };
const bars = { x: chart.x + chart.width - 60, y: chart.y + 120 };
const spots = async () => Object.fromEntries(await Promise.all(["#scale", "#clear-history"].map(async (sel) => { const b = await frame.locator(sel).boundingBox(); return [sel, `${Math.round(b.x)},${Math.round(b.y)}`]; })));
/** Light pixels in the cap rows at the top of the plot, and the x of the first. */
const caps = () => f.evaluate(() => {
  const c = document.getElementById("chart"); const r = devicePixelRatio; const ctx = c.getContext("2d");
  const y = Math.round(9 * r); const x0 = Math.round(44 * r); const data = ctx.getImageData(x0, y, c.width - x0 - Math.round(8 * r), 1).data;
  let count = 0, first = -1; for (let i = 0; i < data.length; i += 4) if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) { count++; if (first < 0) first = i / 4; }
  return { count, firstCss: first < 0 ? null : (x0 + first) / r };
});
/** Time from a real input to a changed chart frame, measured inside the page. */
async function timed(action) {
  await f.evaluate(() => { const c = document.getElementById("chart"); window.__before = c.toDataURL(); window.__changedAt = 0; window.__t0 = 0;
    const look = () => { if (c.toDataURL() !== window.__before) { window.__changedAt = performance.now(); return; } requestAnimationFrame(look); };
    addEventListener("keydown", () => (window.__t0 ||= performance.now()), { capture: true, once: true });
    addEventListener("pointerdown", () => (window.__t0 ||= performance.now()), { capture: true, once: true });
    addEventListener("wheel", () => (window.__t0 ||= performance.now()), { capture: true, once: true });
    addEventListener("dblclick", () => (window.__t0 ||= performance.now()), { capture: true, once: true });
    requestAnimationFrame(look); });
  await action();
  await page.waitForTimeout(250);
  return f.evaluate(() => (window.__changedAt && window.__t0 ? Math.round(window.__changedAt - window.__t0) : null));
}
async function pick(label) {
  await frame.locator("#scale").click();
  await frame.getByText(label, { exact: true }).last().click();
}

// A run starts on Auto, whatever the last one left.
if ((await saved()) !== "auto") { await pick("Auto"); await page.waitForTimeout(500); }
// 1. Nothing on the right moves while the pointer moves around the timeline.
const start = await spots();
await page.mouse.move(bars.x, bars.y); await page.waitForTimeout(150);
const overBars = await spots(); const barHint = await frame.locator("#tl-hint").textContent();
await page.mouse.move(numbers.x, numbers.y); await page.waitForTimeout(150);
const overNumbers = await spots(); const numberHint = await frame.locator("#tl-hint").textContent();
check("Scale and Clear history stay put on hover", JSON.stringify(start) === JSON.stringify(overBars) && JSON.stringify(start) === JSON.stringify(overNumbers), `${JSON.stringify(start)} | bars: "${barHint}" | numbers: "${numberHint}"`);
check("Auto draws no caps", (await caps()).count === 0);

// 2. Choosing 2 ms from the Hubble list: drawn at once, saved after.
let ms = await timed(() => pick("2 ms"));
check("2 ms from the list redraws the chart", ms !== null, `click to changed frame ${ms} ms (includes the list click)`);
await page.waitForTimeout(300);
check("2 ms is saved", (await saved()) === 2, `saved ${await saved()}`);
const capped = await caps();
check("Bars past 2 ms end in a light cap", capped.count > 0, `${capped.count} cap pixels`);
if (capped.firstCss !== null) {
  await page.mouse.move(chart.x + capped.firstCss + 0.5, chart.y + 100); await page.waitForTimeout(150);
  const hint = await frame.locator("#tl-hint").textContent();
  check("Hovering a capped bar gives its real time", /past the top of the scale/u.test(hint) && /ms/u.test(hint), hint);
}

// 3. A held save: the chart and menu change at once, a second change goes on top, and both land in order.
await simulate({ holdSaves: true });
ms = await timed(() => pick("5 ms"));
check("5 ms shows while its save is held", (await frame.locator("#scale").inputValue()) === "5" && ms !== null && (await saved()) === 2, `redraw ${ms} ms, saved still ${await saved()}`);
await pick("10 ms");
check("A second choice works while the first save waits", (await frame.locator("#scale").inputValue()) === "10");
await simulate({ releaseSaves: true }); await page.waitForTimeout(600);
check("Both saves land, newest last", (await saved()) === 10 && (await frame.locator("#scale").inputValue()) === "10", `saved ${await saved()}`);

// 4. A failed save goes back to the last saved scale and says so in the fading toast.
await simulate({ failNextSave: true });
await pick("50 ms"); await page.waitForTimeout(800);
const frameText = await f.evaluate(() => document.body.innerText);
check("A failed save rolls back to 10 ms", (await frame.locator("#scale").inputValue()) === "10" && (await saved()) === 10, `menu ${await frame.locator("#scale").inputValue()}, saved ${await saved()}; refused text seen: ${/refused/u.test(frameText)}`);

// 5. Pinch over the numbers steps the scale; apart is taller (smaller), together is shorter (bigger).
await page.mouse.move(numbers.x, numbers.y);
await page.keyboard.down("Control");
ms = await timed(() => page.mouse.wheel(0, -40));
await page.keyboard.up("Control"); await page.waitForTimeout(400);
check("Pinching apart over the numbers goes 10 → 5 ms", (await saved()) === 5 && (await frame.locator("#scale").inputValue()) === "5", `wheel to frame ${ms} ms, saved ${await saved()}`);
await page.keyboard.down("Control"); await page.mouse.wheel(0, 40); await page.waitForTimeout(100); await page.mouse.wheel(0, 40); await page.keyboard.up("Control"); await page.waitForTimeout(400);
check("Pinching together goes up two steps to 20 ms", (await saved()) === 20, `saved ${await saved()}`);
// A pinch over the bars still zooms time and leaves the scale alone.
await page.mouse.move(bars.x, bars.y); await page.keyboard.down("Control"); await page.mouse.wheel(0, 60); await page.keyboard.up("Control"); await page.waitForTimeout(400);
check("Pinching over the bars leaves the scale", (await saved()) === 20);

// 6. Double-click the numbers for Auto.
ms = await timed(() => page.mouse.dblclick(numbers.x, numbers.y));
await page.waitForTimeout(400);
check("Double-clicking the numbers returns to Auto", (await saved()) === "auto" && (await frame.locator("#scale").inputValue()) === "" && (await caps()).count === 0, `dblclick to frame ${ms} ms`);
await page.mouse.move(numbers.x, numbers.y); await page.keyboard.down("Control"); await page.mouse.wheel(0, -40); await page.keyboard.up("Control"); await page.waitForTimeout(400);
const fromAuto = await saved();
check("A pinch from Auto starts at the scale on screen", typeof fromAuto === "number" && fromAuto < 40, `Auto top 40 → ${fromAuto}`);

// 7. Undo in the sheet takes the scale back.
await frame.locator('td[data-row-id="seed-1"][data-column-id="name"]').click();
await page.keyboard.press("Meta+z"); await page.waitForTimeout(500);
check("⌘Z undoes the scale", (await saved()) === "auto", `saved ${await saved()}`);

// 8. Back to now appears without moving Scale or Clear history.
await page.mouse.move(bars.x, bars.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(400);
const live = await frame.locator("#tl-live").isVisible();
const panned = await spots();
check("Back to now appears and nothing on the right moves", live && JSON.stringify(panned) === JSON.stringify(start), `${JSON.stringify(panned)}, Back to now visible ${live}`);
await frame.locator("#timeline, section.timeline").first().screenshot({ path: `${shots}/scale-check-back-to-now.png` });
await pick("2 ms"); await page.waitForTimeout(300);
await frame.locator("#tl-live").click(); await page.waitForTimeout(300);
await frame.locator("section.timeline").screenshot({ path: `${shots}/scale-check-final.png` });
await browser.close();
const failed = results.filter((item) => !item.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
