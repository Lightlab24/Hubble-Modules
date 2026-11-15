// Real input against tools/preview.ts with ten four-channel simulators: Send all to 40 channels, slider values sent while
// dragging, and the − and + beside every slider.
//   FSHDR_SIMULATOR_DIR=<simulator> FSHDR_SIMULATORS=four,four,four,four,four,four,four,four,four,four PORT=43972 FSHDR_SIMULATOR_PORT=44001 node --import tsx tools/preview.ts
//   PREVIEW_ORIGIN=http://127.0.0.1:43972 PLAYWRIGHT=<path to @playwright/test/index.mjs> CHROME=<path to a Chromium> node tools/qa-live.mjs
import assert from 'node:assert/strict';
const { chromium, expect } = await import(process.env.PLAYWRIGHT ?? '@playwright/test');
const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:43972', shots = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 900 }, deviceScaleFactor: 2 })).newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const state = async () => (await fetch(origin + '/fixture/state')).json();
const check = text => console.log('ok - ' + text);
const hosts = (await state()).simulatorHosts;
assert.equal(hosts.length, 10, 'ten simulators');
const unit = index => 'unit-' + (index + 1);
const sim = async (index, id) => (await (await fetch('http://' + hosts[index] + '/config?action=get&alt=json&configid=0&paramid=' + id)).json()).value;
const simSet = (index, id, value) => fetch('http://' + hosts[index] + '/config?action=set&configid=0&paramid=' + id + '&value=' + encodeURIComponent(value));
const everySim = async id => Promise.all(hosts.flatMap((_, index) => [1, 2, 3, 4].map(channel => sim(index, id.replace('#', channel)))));
await page.goto(origin);
const f = page.frameLocator('iframe');
const cell = (row, column) => f.locator(`.sheet-scroll:not([hidden]) td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const tab = name => f.getByRole('tab', { name });
const number = (row, column) => cell(row, column).locator('.hubble-slider-value');
const reading = async (row, column) => Number((await number(row, column).textContent()).replace(/\s*%$/, ''));
const staged = async (row, column) => { const { document } = await state(), [unitId, channel] = row.split('#'), found = document.units.find(item => item.id === unitId); return (channel === undefined ? found.values : found.channels?.[channel] ?? {})[column] ?? ''; };
async function type(row, column, value) { await cell(row, column).scrollIntoViewIfNeeded(); const shown = cell(row, column).locator('.hubble-slider-value'); await ((await shown.count()) ? shown : cell(row, column)).dblclick(); const input = cell(row, column).locator('input.cell-input'); await expect(input).toBeVisible(); await input.fill(value); await input.press('Enter'); }
async function show(label) { await f.locator('.toolbar [data-for]:not([hidden]) button[aria-label="Choose visible columns"]').click(); const search = f.getByRole('searchbox', { name: 'Search columns' }); await search.fill(label); const item = f.getByRole('menuitemcheckbox', { name: label, exact: true }); if (await item.getAttribute('aria-checked') !== 'true') await item.click(); await search.press('Escape'); }
const shot = async name => { if (shots) await page.screenshot({ path: shots + '/' + name + '.png' }); };
/** Presses on a slider's track and moves along it slowly, giving back the unit's value part-way and at the end, before letting go. */
async function slowDrag(row, column, from, to, readMid) {
  await cell(row, column).scrollIntoViewIfNeeded();
  const box = await cell(row, column).locator('.hubble-slider-root').boundingBox(), y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y); await page.mouse.down();
  let mid;
  for (let step = 1; step <= 10; step++) { await page.mouse.move(box.x + box.width * (from + (to - from) * step / 10), y); await page.waitForTimeout(80); if (step === 5) mid = await readMid(); }
  await page.waitForTimeout(400);
  const beforeRelease = await readMid();
  await page.mouse.up();
  return { mid, beforeRelease };
}
try {
  await expect(f.locator('#fleet-status')).toHaveText('10 units / 10 live', { timeout: 20000 });
  // The simulator, unlike the real unit, refuses Custom Size while Custom Size/Pos is off. Switch it on everywhere first.
  await Promise.all(hosts.flatMap((_, index) => [1, 2, 3, 4].map(channel => simSet(index, 'eParamID_Vid' + channel + 'CustomSizePos', '1'))));

  // Send all to 40 channels at once: every one goes, none is refused by the page-request limit.
  await tab(/Master/).click();
  await show('Custom Size');
  await f.locator('#master-all').click();
  await expect(f.locator('#master-summary')).toHaveText('Editing 40 of 40 channels');
  await type('master', 'Vid#CustomSize', '130');
  await expect(f.locator('#send-all-bar-count')).toHaveText('40');
  const started = Date.now();
  await f.locator('#send-all-bar').click();
  await expect(f.locator('#pending-status')).toHaveText('No changes pending', { timeout: 30000 });
  const tookMs = Date.now() - started;
  assert.deepEqual([...new Set(await everySim('eParamID_Vid#CustomSize'))], ['1300']);
  await expect(f.locator('#error')).toBeHidden();
  check('Send all to 40 channels on ten units writes every one, with no request refused (' + tookMs + ' ms)');

  // Auto send: a drag sends as it moves, before the pointer lets go. The release lands too, and nothing stays staged.
  await f.locator('#send-auto').click();
  await tab(/HDR/).click();
  const ch = unit(0) + '#1';
  await show('Custom Size');
  await expect(number(ch, 'Vid#CustomSize')).toHaveText('130.0 %');
  const unitValue = async () => Number(await sim(0, 'eParamID_Vid1CustomSize')) / 10;
  const { mid, beforeRelease } = await slowDrag(ch, 'Vid#CustomSize', 0.06, 0.5, unitValue);
  const released = await reading(ch, 'Vid#CustomSize');
  assert.ok(mid !== 130, 'the unit moved during the drag: ' + mid);
  assert.equal(beforeRelease, released, 'the unit had the thumb’s value before the pointer let go');
  await expect.poll(unitValue).toBe(released);
  await expect(cell(ch, 'Vid#CustomSize')).toHaveAttribute('data-pending', 'false');
  await expect.poll(() => staged(ch, 'Vid#CustomSize')).toBe('');
  await shot('live-drag');
  check('with Auto send on, a drag sends as it moves (' + mid + ' % half-way, ' + beforeRelease + ' % before letting go) and nothing stays staged');

  // − and + step by the unit's own step. Shift steps ten. Held, they keep going and send as they go.
  const plus = cell(ch, 'Vid#CustomSize').locator('.slider-step').nth(1), minus = cell(ch, 'Vid#CustomSize').locator('.slider-step').nth(0);
  await plus.click();
  await expect(number(ch, 'Vid#CustomSize')).toHaveText((released + 0.1).toFixed(1) + ' %');
  await expect.poll(unitValue).toBe(Number((released + 0.1).toFixed(1)));
  await plus.click({ modifiers: ['Shift'] });
  await expect.poll(unitValue).toBe(Number((released + 1.1).toFixed(1)));
  check('+ steps 0.1 % and Shift-+ steps 1 %, each reaching the unit with Auto send on');
  const box = await minus.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const top = await unitValue();
  await page.mouse.down(); await page.waitForTimeout(1500);
  const whileHeld = await unitValue();
  await page.mouse.up();
  const after = await reading(ch, 'Vid#CustomSize');
  assert.ok(whileHeld < top - 0.5, 'holding − kept lowering the unit while held: ' + top + ' → ' + whileHeld);
  await expect.poll(unitValue).toBe(after);
  await expect.poll(() => staged(ch, 'Vid#CustomSize')).toBe('');
  check('holding − keeps stepping and sends while held (' + top + ' → ' + whileHeld + ' % held, ' + after + ' % on release)');

  // Manual send: − stages one value and nothing reaches the unit until Send.
  await f.locator('#send-manual').click();
  const resting = await unitValue();
  await minus.click();
  await expect(cell(ch, 'Vid#CustomSize')).toHaveAttribute('data-pending', 'true');
  assert.equal(await staged(ch, 'Vid#CustomSize'), (resting - 0.1).toFixed(1));
  await page.waitForTimeout(300);
  assert.equal(await unitValue(), resting);
  const { mid: manualMid } = await slowDrag(ch, 'Vid#CustomSize', 0.3, 0.1, unitValue);
  assert.equal(manualMid, resting, 'a manual drag sends nothing');
  await f.locator('#send-all-bar').click();
  await expect(f.locator('#pending-status')).toHaveText('No changes pending', { timeout: 15000 });
  await expect.poll(unitValue).toBe(await reading(ch, 'Vid#CustomSize'));
  check('with Auto send off, − and a drag only stage, and Send writes them');

  // Master with all 40 ticked: a drag reaches every unit while it moves.
  await f.locator('#send-auto').click();
  await tab(/Master/).click();
  await type('master', 'Vid#CustomSize', '100'); await expect.poll(async () => [...new Set(await everySim('eParamID_Vid#CustomSize'))], { timeout: 20000 }).toEqual(['1000']);
  const spread = async () => new Set(await everySim('eParamID_Vid#CustomSize')).size === 1 ? Number((await everySim('eParamID_Vid#CustomSize'))[0]) / 10 : NaN;
  const { mid: masterMid } = await slowDrag('master', 'Vid#CustomSize', 0.0, 0.3, async () => (await everySim('eParamID_Vid#CustomSize')).filter(value => value !== '1000').length);
  assert.ok(masterMid > 0, 'channels moved during the Master drag: ' + masterMid + ' of 40');
  const masterFinal = await reading('master', 'Vid#CustomSize');
  await expect.poll(spread, { timeout: 20000 }).toBe(masterFinal);
  await expect(f.locator('#pending-status')).toHaveText('No changes pending', { timeout: 15000 });
  await shot('master-live');
  check('a Master drag with 40 channels ticked sends as it moves (' + masterMid + ' of 40 moved half-way) and all 40 end on ' + masterFinal + ' %');
  await f.locator('#send-manual').click();

  // Custom Size/Pos off: Custom Size, Position and Crop stay editable.
  await simSet(1, 'eParamID_Vid2CustomSizePos', '0');
  await tab(/HDR/).click();
  await show('Custom H Pos');
  await expect(cell(unit(1) + '#2', 'Vid#CustomSize').getByRole('slider')).not.toHaveAttribute('data-disabled', '', { timeout: 5000 });
  await expect(cell(unit(1) + '#2', 'Vid#CustomHPosition')).toHaveAttribute('aria-readonly', 'false');
  for (const step of await cell(unit(1) + '#2', 'Vid#CustomSize').locator('.slider-step').all()) await expect(step).toBeEnabled();
  check('with Custom Size/Pos off, Custom Size and H Pos stay editable with their − and +');
  await shot('steppers');
  assert.deepEqual(errors, []);
  check('no page errors');
} finally { await browser.close(); }
