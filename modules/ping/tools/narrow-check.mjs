// Checks the Ping page in narrow windows, down to 420 px (HubDash's narrowest module window), against
// a running preview with fake pings:
//   pnpm build && PING_PREVIEW_FAKE=1 PING_PREVIEW_PORT=43291 npx tsx tools/preview.ts
//   PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<Chrome for Testing> PREVIEW_ORIGIN=http://127.0.0.1:43291 node tools/narrow-check.mjs
// At each width: nothing in the header, the toolbars, the timeline's head and the row under it runs
// past the window; a toolbar divider shows only between two groups on one line; nothing moves when
// hover text changes or Back to now appears; and Colors opens just above its button, inside the window.
// SHOTS=<folder> keeps a picture at each width.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "@playwright/test");
const origin = process.env.PREVIEW_ORIGIN ?? "http://127.0.0.1:43291";
const widths = (process.env.WIDTHS ?? "1600,1186,1100,900,760,640,600,420").split(",").map(Number);
const shots = process.env.SHOTS;
const controls = ["#add-device", "#device-count", "#pinging", "#every", "#size", "#span", "#text-size", "#columns", "#alert-over", "#alert-lost", "#notify", "#fleet", "#viewport", "#sheet-tabs", "#tl-name", "#chart", "#legend-chips", "#colors", "#tl-live", "#scale", "#scale-auto", "#clear-history", "#tl-hint", "#save-status"];
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
};

const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
try {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    const frame = page.frameLocator("iframe");
    await frame.locator("#device-grid tbody tr").first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const inner = page.frames().find((item) => item !== page.mainFrame());

    const past = await inner.evaluate(() => {
      const edge = document.documentElement.clientWidth + 0.5;
      const rows = [...document.querySelectorAll(".app-header, .toolbar, .tl-head, .legend, .app-footer")];
      return rows.flatMap((row) => [...row.querySelectorAll("*")])
        .filter((element) => element.checkVisibility() && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().right > edge)
        .map((element) => element.id || element.className || element.tagName);
    });
    check(`${width} px: nothing runs past the window`, past.length === 0, past.slice(0, 5).join(", "));

    const dividers = await inner.evaluate(() => [...document.querySelectorAll(".toolbar-divider")].map((divider) => {
      const middle = (element) => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
      const between = Math.abs(middle(divider.previousElementSibling) - middle(divider)) < 4 && Math.abs(middle(divider.nextElementSibling) - middle(divider)) < 4;
      return between === (getComputedStyle(divider).visibility !== "hidden");
    }));
    check(`${width} px: a divider shows only between two groups on one line`, dividers.every(Boolean));

    const where = () => inner.evaluate((selectors) => JSON.stringify(selectors.map((selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return [selector, Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)];
    })), controls);
    const before = await where();
    const chart = await frame.locator("#chart").boundingBox();
    for (const x of [0.97, 0.9, 0.8]) {
      await page.mouse.move(chart.x + chart.width * x, chart.y + chart.height * 0.8);
      await page.waitForTimeout(150);
    }
    const hint = await frame.locator("#tl-hint").textContent();
    check(`${width} px: hover text in the hint moves nothing`, !hint.startsWith("Pinch") && (await where()) === before, hint);
    // Two fingers to the right go back through time, so the timeline stops following and offers Back to now.
    await page.mouse.move(chart.x + chart.width * 0.6, chart.y + chart.height * 0.5);
    for (let step = 0; step < 6; step++) await page.mouse.wheel(-120, 0);
    await page.waitForTimeout(400);
    check(`${width} px: Back to now appears and moves nothing`, (await frame.locator("#tl-live").isVisible()) && (await where()) === before);
    await frame.locator("#tl-live").click();

    await frame.locator("#colors").click();
    const panel = await frame.locator("#colors-panel").boundingBox();
    const button = await frame.locator("#colors").boundingBox();
    const gap = Math.round(button.y - (panel.y + panel.height));
    check(`${width} px: Colors opens 9 px above its button, inside the window`, gap === 9 && panel.x >= 0 && panel.x + panel.width <= width && panel.y >= 0, `${gap} px`);
    await page.keyboard.press("Escape");

    if (shots) await page.screenshot({ path: `${shots}/ping-${width}.png` });
    check(`${width} px: no page errors`, errors.length === 0, errors.join("; "));
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
