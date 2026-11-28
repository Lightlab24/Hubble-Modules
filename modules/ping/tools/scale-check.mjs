// Checks the timeline's Scale and Colors with real input against a running
// `PING_PREVIEW_FAKE=1 pnpm preview` whose first device answers: dragging and pinching the ms numbers,
// the Scale box and Auto, that the scale is this window's own and never saved with the list, a held
// and a failed save of the colour times, Undo, and that nothing on the right of the row under the
// timeline ever moves.
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
const inspect = async () => (await (await fetch(`${base}/__inspect`)).json());
const view = async () => (await inspect()).document.view;
/** The scale this window is on, as the worker remembers it for the next time the page opens (place.ts). */
const scale = async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return (await inspect()).place?.scaleMs ?? "auto";
};
const writes = async () => Number((await inspect()).revision.split("-")[1]);
const simulate = (body) => fetch(`${base}/__simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
await page.goto(base);
const frame = page.frameLocator("iframe");
await frame.locator("#loading").waitFor({ state: "hidden" });
const f = page.frames().find((item) => item !== page.mainFrame());
await page.waitForTimeout(800);
// The user's device has no Alert Over of its own, and the run starts on Auto with colours following the alert limit.
const over = frame.locator('td[data-row-id="seed-1"][data-column-id="over"]');
if ((await over.textContent()).trim()) { await over.click(); await page.keyboard.press("Backspace"); }
await frame.locator('td[data-row-id="seed-1"][data-column-id="name"]').click();
await frame.getByRole("radio", { name: "1 min" }).or(frame.getByRole("button", { name: "1 min" })).first().click();
if ((await scale()) !== "auto") await frame.locator("#scale-auto").click();
if ((await view()).bands) {
  await frame.locator("#colors").click();
  await frame.locator(".follow-alert").click();
  await page.keyboard.press("Escape");
}
await page.waitForTimeout(1500);

const chart = await frame.locator("#chart").boundingBox();
const plot = { top: chart.y + 8, height: chart.height - 30 };
const yOf = (value, top) => plot.top + plot.height * (1 - value / top);
const numbersX = chart.x + 22;
const bars = { x: chart.x + chart.width - 60, y: chart.y + 120 };
const right = ["#scale", "#scale-auto", "#clear-history"];
const spots = async () => JSON.stringify(Object.fromEntries(await Promise.all(right.map(async (sel) => { const b = await frame.locator(sel).boundingBox(); return [sel, `${Math.round(b.x)},${Math.round(b.y)}`]; }))));
/** Pixels on a canvas near a colour. */
const pixels = (hex, selector = "#chart") => f.evaluate(([hex, selector]) => {
  const c = document.querySelector(selector); const ctx = c.getContext("2d");
  const want = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const data = ctx.getImageData(0, 0, c.width, c.height).data; let count = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.abs(data[i] - want[0]) < 14 && Math.abs(data[i + 1] - want[1]) < 14 && Math.abs(data[i + 2] - want[2]) < 14) count++;
  return count;
}, [hex, selector]);
/** Time from a real input to a changed chart frame, measured in the page. */
async function timed(action) {
  await f.evaluate(() => { const c = document.getElementById("chart"); window.__before = c.toDataURL(); window.__changedAt = 0; window.__t0 = 0;
    const look = () => { if (c.toDataURL() !== window.__before) { window.__changedAt = performance.now(); return; } requestAnimationFrame(look); };
    for (const type of ["keydown", "pointerdown", "wheel", "dblclick"]) addEventListener(type, () => (window.__t0 ||= performance.now()), { capture: true, once: true });
    requestAnimationFrame(look); });
  await action();
  await page.waitForTimeout(250);
  return f.evaluate(() => (window.__changedAt && window.__t0 ? Math.round(window.__changedAt - window.__t0) : null));
}
async function drag(fromY, toY) {
  await page.mouse.move(numbersX, fromY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) await page.mouse.move(numbersX, fromY + ((toY - fromY) * step) / 12);
  await page.mouse.up();
  await page.waitForTimeout(400);
}
const box = frame.locator("#scale .hubble-stepper-input");
async function typeScale(text) {
  await box.click(); await box.press("Meta+a"); await box.type(text); await box.press("Enter");
}

// 1. The right of the row never moves.
const start = await spots();
await page.mouse.move(bars.x, bars.y); await page.waitForTimeout(150);
const overBars = await spots();
await page.mouse.move(numbersX, plot.top + 40); await page.waitForTimeout(150);
const hint = await frame.locator("#tl-hint").textContent();
check("Scale, Auto and Clear history stay put on hover", start === overBars && start === (await spots()), hint);
check("Auto is on, and its box shows Auto's top, dimmed", (await frame.locator("#scale-auto").getAttribute("aria-pressed")) === "true" && (await f.evaluate(() => document.getElementById("scale").dataset.auto)) === "true", `box ${await box.inputValue()}`);

// 2. Drag the numbers: the grabbed number lands under the pointer. The scale is this window's own, so the list isn't saved.
const autoTop = Number(await box.inputValue());
let before = await writes();
await drag(yOf(autoTop / 4, autoTop), yOf(autoTop, autoTop));
check("Dragging a quarter-height number to the top sets that scale", (await scale()) === autoTop / 4 && (await writes()) === before && (await view()).scaleMs === undefined, `Auto ${autoTop} → ${await scale()}, ${(await writes()) - before} saves of the list`);
let top = await scale();
await drag(yOf(top / 5, top), yOf(top, top));
check("A second drag goes on from there", (await scale()) === top / 5, `→ ${await scale()}`);

// 3. The box: type any value, − and +.
let ms = await timed(() => typeScale("2.5"));
check("Typing 2.5 sets 2.5 ms", (await scale()) === 2.5 && (await frame.locator("#scale-auto").getAttribute("aria-pressed")) === "false", `Enter to new frame ${ms} ms`);
ms = await timed(() => frame.getByRole("button", { name: "Decrease Scale" }).click());
check("− steps 2.5 → 2", (await scale()) === 2, `click to new frame ${ms} ms`);
await frame.getByRole("button", { name: "Increase Scale" }).click(); await page.waitForTimeout(300);
check("+ steps 2 → 2.2, about a tenth", (await scale()) === 2.2, `saved ${await scale()}`);
await typeScale("2.37"); await page.waitForTimeout(300);
check("A typed value keeps one decimal", (await scale()) === 2.4, `2.37 saved as ${await scale()}`);
await box.press("ArrowDown"); await page.waitForTimeout(300);
check("The down arrow in the box goes to the next round number down, 2", (await scale()) === 2, `saved ${await scale()}`);
await typeScale("2.5"); await page.waitForTimeout(300);
const capped = await f.evaluate(() => { const c = document.getElementById("chart"); const r = devicePixelRatio; const d = c.getContext("2d").getImageData(Math.round(44 * r), Math.round(9 * r), c.width - Math.round(52 * r), 1).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) n++; return n; });
check("Bars past 2.5 ms end in a light cap", capped > 0, `${capped} cap pixels`);

// 4. Auto and back.
await frame.locator("#scale-auto").click(); await page.waitForTimeout(300);
check("Auto returns to Auto", (await scale()) === "auto" && (await frame.locator("#scale-auto").getAttribute("aria-pressed")) === "true");
await frame.locator("#scale-auto").click(); await page.waitForTimeout(300);
check("Auto again holds the scale on screen", (await scale()) === Number(await box.inputValue()) && (await scale()) !== "auto", `held at ${await scale()}`);

// 5. A pinch over the numbers changes the scale smoothly and saves once when it rests.
top = await scale(); before = await writes();
await page.mouse.move(numbersX, plot.top + 60);
await page.keyboard.down("Control");
for (let step = 0; step < 6; step++) { await page.mouse.wheel(0, -20); await page.waitForTimeout(30); }
await page.keyboard.up("Control");
const during = Number(await box.inputValue());
await page.waitForTimeout(700);
check("Pinching apart lowers the scale and keeps it at rest", during < top && (await scale()) === during && (await writes()) === before, `${top} → ${during}, ${(await writes()) - before} saves of the list`);
await page.mouse.move(bars.x, bars.y); await page.keyboard.down("Control"); await page.mouse.wheel(0, 60); await page.keyboard.up("Control"); await page.waitForTimeout(500);
check("Pinching over the bars zooms time and leaves the scale", (await scale()) === during);
ms = await timed(() => page.mouse.dblclick(numbersX, plot.top + 60)); await page.waitForTimeout(300);
check("Double-clicking the numbers returns to Auto", (await scale()) === "auto", `to new frame ${ms} ms`);

// 6. The scale never waits on the list: with its saves held, a change shows at once and stays.
await typeScale("10"); await page.waitForTimeout(300);
before = await writes();
await simulate({ holdSaves: true });
ms = await timed(() => typeScale("5"));
await frame.getByRole("button", { name: "Decrease Scale" }).click();
check("5 ms, then 4.5, show at once while the list's saves are held", Number(await box.inputValue()) === 4.5 && (await scale()) === 4.5 && ms !== null, `new frame ${ms} ms`);
await simulate({ releaseSaves: true }); await page.waitForTimeout(300);
check("None of it was saved with the list", (await view()).scaleMs === undefined && (await writes()) === before, `${(await writes()) - before} saves of the list`);

// 7. Colours: fixed green, yellow, orange and red, with the user's times.
await typeScale("10"); await page.waitForTimeout(300);
await frame.locator("#colors").click(); await page.waitForTimeout(300);
check("Before any time, the panel says colours follow the alert limit", (await frame.locator(".colors-note").isVisible()) && (await frame.locator(".follow-alert").isHidden()) && /Answered/u.test(await frame.locator("#legend-chips").textContent()));
const time = (step) => frame.locator(`.band-ms[data-step="${step}"]`);
async function setTime(step, text) {
  await time(step).click(); await time(step).press("Meta+a");
  if (text) await time(step).type(text); else await time(step).press("Backspace");
  await time(step).press("Enter"); await page.waitForTimeout(300);
}
await setTime("green", "1");
check("Typing green 1 ms saves it; over that is red", JSON.stringify((await view()).bands) === '{"green":1,"yellow":null,"orange":null}' && /Up to 1 msOver 1 ms/u.test(await frame.locator("#legend-chips").textContent()), await frame.locator("#legend-chips").textContent());
await simulate({ holdSaves: true });
await setTime("yellow", "1.5");
const legendHeld = await frame.locator("#legend-chips").textContent();
check("Yellow shows at once while its save is held", /1–1\.5 ms/u.test(legendHeld) && (await view()).bands.yellow === null, legendHeld);
await setTime("orange", "5");
check("A second time works while the first waits", /1\.5–5 ms/u.test(await frame.locator("#legend-chips").textContent()));
await simulate({ releaseSaves: true }); await page.waitForTimeout(700);
check("Both land", JSON.stringify((await view()).bands) === '{"green":1,"yellow":1.5,"orange":5}', JSON.stringify((await view()).bands));
const strip = 'td[data-row-id="seed-1"][data-column-id="strip"] canvas';
check("Bars are green, yellow, orange and red by time, on the timeline and the strip",
  (await pixels("#63BC9C")) > 0 && (await pixels("#E6D35C")) > 0 && (await pixels("#E5766A")) > 0 && (await pixels("#E6D35C", strip)) > 0,
  `green ${await pixels("#63BC9C")}, yellow ${await pixels("#E6D35C")}, orange ${await pixels("#F08A4B")}, red ${await pixels("#E5766A")}, strip yellow ${await pixels("#E6D35C", strip)}`);
check("The right of the row didn't move as the legend grew", (await spots()) === start, await spots());
await setTime("yellow", "0.5");
await page.waitForTimeout(1500);
check("Yellow under green is refused, and stays as typed and marked through live updates", (await time("yellow").inputValue()) === "0.5" && (await time("yellow").getAttribute("aria-invalid")) === "true" && (await view()).bands.yellow === 1.5 && /Yellow has to be above green/u.test(await f.evaluate(() => document.body.innerText)));
await setTime("yellow", "1.5");
await simulate({ failNextSave: true });
await setTime("green", "0.8"); await page.waitForTimeout(600);
check("A failed save puts green back to 1 ms", (await view()).bands.green === 1 && (await time("green").inputValue()) === "1");
await setTime("orange", "");
check("Emptying orange leaves it out", (await view()).bands.orange === null && /Over 1\.5 ms/u.test(await frame.locator("#legend-chips").textContent()));
await page.mouse.click(chart.x + 400, chart.y - 200); await page.waitForTimeout(300);
check("A click outside closes the panel", await frame.locator("#colors-panel").isHidden());
await frame.locator('td[data-row-id="seed-1"][data-column-id="name"]').click();
await page.keyboard.press("Meta+z"); await page.waitForTimeout(500);
check("⌘Z brings orange back", (await view()).bands.orange === 5);
await frame.locator("#colors").click(); await page.waitForTimeout(300);
await frame.locator("section.timeline").screenshot({ path: `${shots}/ping-0.1.7-colors.png` });
await page.keyboard.press("Escape"); await page.waitForTimeout(200);
check("Escape closes the panel", await frame.locator("#colors-panel").isHidden());
await frame.locator("section.timeline").screenshot({ path: `${shots}/ping-0.1.7-timeline.png` });
await frame.locator("#colors").click(); await page.waitForTimeout(200);
await frame.locator(".follow-alert").click(); await page.waitForTimeout(400);
check("Follow alert limit drops the times", (await view()).bands === undefined && /Answered/u.test(await frame.locator("#legend-chips").textContent()));
await page.keyboard.press("Escape");

// 8. Back to now appears without moving anything on the right.
await page.mouse.move(bars.x, bars.y); await page.mouse.wheel(0, -300); await page.waitForTimeout(400);
check("Back to now appears and nothing on the right moves", (await frame.locator("#tl-live").isVisible()) && (await spots()) === start);
await frame.locator("#tl-live").click(); await page.waitForTimeout(300);
check("No errors in the page", errors.length === 0, errors.slice(0, 3).join(" | "));
await frame.locator("section.timeline").screenshot({ path: `${shots}/ping-0.1.7-final.png` });
await browser.close();
const failed = results.filter((item) => !item.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
