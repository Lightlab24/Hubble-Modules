// Two copies of the real page side by side, as in two HubDash windows, against one worker and its simulated units.
// Real input goes to one copy and the other must follow without a reload. Nothing reaches a real unit.
//   PREVIEW_COPIES=2 PREVIEW_SIMULATED=2 PREVIEW_STATE_MS=100 node --import tsx tools/preview.ts
//   PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<Chrome for Testing> node tools/qa-windows.mjs
import assert from 'node:assert/strict';
const { chromium, expect } = await import(process.env.PLAYWRIGHT ?? '@playwright/test');
const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:43971', shots = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 2400, height: 800 } })).newPage();
const errors = [], missing = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) missing.push(response.status() + ' ' + new URL(response.url()).pathname); });
const state = async () => (await fetch(origin + '/fixture/state')).json();
const check = text => console.log('ok - ' + text);
const one = page.frameLocator('iframe >> nth=0'), two = page.frameLocator('iframe >> nth=1');
const cell = (frame, row, column) => frame.locator(`.sheet-scroll:not([hidden]) td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const tab = (frame, name) => frame.getByRole('tab', { name });
async function type(frame, row, column, value) { await cell(frame, row, column).scrollIntoViewIfNeeded(); await cell(frame, row, column).dblclick(); const input = cell(frame, row, column).locator('input.cell-input'); await expect(input).toBeVisible(); await input.fill(value); await input.press('Enter'); }
const staged = async (row, column) => (await state()).document.units.find(unit => unit.id === row)?.values[column] ?? '';
const shot = async name => { if (shots) await page.screenshot({ path: shots + '/' + name + '.png' }); };
try {
  await page.goto(origin);
  for (const frame of [one, two]) await expect(frame.locator('#fleet-status')).toHaveText('2 units / 2 simulated', { timeout: 15000 });
  check('both copies load and show the two simulated units');

  // The open tab is saved with the plan, so it is shared: opening Setup in one copy opens it in the other.
  await tab(one, /Setup/).click();
  await expect(tab(two, /Setup/)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(two, 'sim-1', 'ChannelName1')).toBeVisible();
  check('a tab opened in one copy opens in the other');

  await type(one, 'sim-1', 'ChannelName1', 'CAM 1');
  await expect(cell(two, 'sim-1', 'ChannelName1')).toHaveText('CAM 1');
  assert.equal(await staged('sim-1', 'ChannelName1'), 'CAM 1');
  check('a label typed in the first copy shows in the second without reloading it');

  // The second copy changes that cell and another, never having been reloaded.
  await type(two, 'sim-1', 'ChannelName1', 'CAM 2');
  await type(two, 'sim-2', 'ChannelName2', 'ISO');
  await expect(cell(one, 'sim-1', 'ChannelName1')).toHaveText('CAM 2');
  await expect(cell(one, 'sim-2', 'ChannelName2')).toHaveText('ISO');
  assert.equal(await staged('sim-1', 'ChannelName1'), 'CAM 2');
  assert.equal(await staged('sim-2', 'ChannelName2'), 'ISO');
  check('the second copy’s edits land, on that cell too, and show in the first');
  await shot('windows-edits');

  for (const frame of [one, two]) {
    await expect(frame.locator('#error')).toBeHidden();
    await expect(frame.locator('#save-status')).toHaveText('Workspace saved');
  }
  check('neither copy shows a refusal, and both say the workspace is saved');
  assert.deepEqual(missing, [], 'every file the pages ask for loads');
  assert.deepEqual(errors, []);
  check('no page errors');
} finally { await browser.close(); }
