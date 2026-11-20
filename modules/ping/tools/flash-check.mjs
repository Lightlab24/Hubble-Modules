// Watches the timeline frame by frame across each Show last switch, against a running `pnpm preview`.
// Prints how much of its width has bars over time, and whether any earlier picture came back (a flash).
// Run it from a folder that has @playwright/test, with CHROME set to a Chrome for Testing binary.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: process.env.CHROME });
const page = await browser.newPage({ viewport: { width: 1320, height: 820 } });
await page.goto('http://127.0.0.1:43191/');
const frame = page.frameLocator('iframe');
await frame.locator('#device-grid tbody tr').first().waitFor({ timeout: 15000 });
await frame.locator('#device-grid tbody tr:nth-child(1) td[data-column-id="name"]').click();
await page.waitForTimeout(Number(process.env.WARM || 3000));
const chart = frame.locator('#chart');
// Starts sampling inside the page: one reading per animation frame.
const start = () => chart.evaluate((canvas) => {
  const samples = []; window.__samples = samples; const t0 = performance.now();
  const context = canvas.getContext('2d');
  const read = () => {
    const w = canvas.width, h = canvas.height, ratio = w / canvas.clientWidth;
    const left = Math.round(44 * ratio), right = w - Math.round(8 * ratio), top = Math.round(8 * ratio), bottom = h - Math.round(22 * ratio);
    const data = context.getImageData(left, top, right - left, bottom - top).data, width = right - left, height = bottom - top;
    // A column counts when it holds a bar pixel: green, amber or red, never the grey grid or the dashed limit line alone.
    let lit = 0;
    for (let x = 0; x < width; x++) {
      let bar = 0;
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
        if ((g > 150 && g > r + 40) || (r > 180 && bl < 150 && Math.abs(r - g) > 60)) bar++;
        else if (r > 190 && g > 160 && bl < 150 && y > 0) bar += 0.34;
      }
      if (bar >= 1) lit++;
    }
    const pct = Math.round(lit / width * 100);
    // A cheap fingerprint of the whole plot, so the same picture coming back can be told.
    let hash = 0; for (let i = 0; i < data.length; i += 16) hash = (hash * 31 + data[i] + data[i + 1] * 3) | 0;
    samples.push([Math.round(performance.now() - t0), pct, hash]);
    if (performance.now() - t0 < 2600) requestAnimationFrame(read);
  };
  requestAnimationFrame(read);
});
const stop = () => chart.evaluate(() => window.__samples);
const runs = (samples) => { const out = []; for (const [t, v] of samples.map(s => [s[0], s[1]])) { const last = out.at(-1); if (last && Math.abs(last[1] - v) <= 2) last[2] = t; else out.push([t, v, t]); } return out.map(([a, v, b]) => `${v}%@${a}-${b}ms`).join('  '); };
for (const [from, to] of [['10 min', '1 min'], ['1 min', '10 min'], ['10 min', '1 hr'], ['1 hr', '1 min'], ['1 min', '24 hr'], ['24 hr', '10 min']]) {
  await frame.getByRole('radio', { name: from, exact: true }).click(); await page.waitForTimeout(2600);
  await start();
  await page.waitForTimeout(150);
  await frame.getByRole('radio', { name: to, exact: true }).click();
  await page.waitForTimeout(2700);
  const samples = await stop();
  // Pictures in order, each once per run of identical frames. A picture that returns after a different one is a flash.
  const order = []; for (const sample of samples) if (order.at(-1) !== sample[2]) order.push(sample[2]);
  const returned = order.filter((hash, index) => order.indexOf(hash) !== index).length;
  console.log(`${from} -> ${to}: ${runs(samples)} | ${order.length} pictures, ${returned} came back`);
}
await frame.getByRole('radio', { name: '10 min', exact: true }).click();
await browser.close();
