// Real input in a real browser against tools/preview.ts and its simulators. Every step reads the result from the page and from the simulator.
//   PLAYWRIGHT=<path to @playwright/test/index.mjs> node tools/qa-smoke.mjs
import assert from 'node:assert/strict';
const { chromium, expect } = await import(process.env.PLAYWRIGHT ?? '@playwright/test');
const origin = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:43971', shots = process.env.SHOTS;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 800 }, deviceScaleFactor: 2 })).newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const state = async () => (await fetch(origin + '/fixture/state')).json();
const post = (path, value) => fetch(origin + path, { method: 'POST', body: value === undefined ? undefined : JSON.stringify(value) });
const check = text => console.log('ok - ' + text);
const hosts = (await state()).simulatorHosts;
const unit = index => 'unit-' + (index + 1);
const sim = async (index, id) => (await (await fetch('http://' + hosts[index] + '/config?action=get&alt=json&configid=0&paramid=' + id)).json()).value;
const simSet = (index, id, value) => fetch('http://' + hosts[index] + '/config?action=set&configid=0&paramid=' + id + '&value=' + encodeURIComponent(value));
await page.goto(origin);
const f = page.frameLocator('iframe');
const cell = (row, column) => f.locator(`.sheet-scroll:not([hidden]) td[data-hubble-row="${row}"][data-hubble-column="${column}"]`);
const tab = name => f.getByRole('tab', { name });
const staged = async (row, column) => { const { document } = await state(), [unitId, channel] = row.split('#'), found = document.units.find(item => item.id === unitId); return (channel === undefined ? found.values : found.channels?.[channel] ?? {})[column] ?? ''; };
async function type(row, column, value) { await cell(row, column).scrollIntoViewIfNeeded(); await cell(row, column).dblclick(); const input = cell(row, column).locator('input.cell-input'); await expect(input).toBeVisible(); await input.fill(value); await input.press('Enter'); }
async function choose(row, column, label) { await cell(row, column).scrollIntoViewIfNeeded(); await cell(row, column).click(); await page.keyboard.press('Enter'); await f.getByRole('option', { name: label, exact: true }).click(); }
async function show(label) { await f.locator('.toolbar [data-for]:not([hidden]) button[aria-label="Choose visible columns"]').click(); const search = f.getByRole('searchbox', { name: 'Search columns' }); await search.fill(label); await f.getByRole('menuitemcheckbox', { name: label, exact: true }).click(); await search.press('Escape'); }
const sendAll = async () => { await expect(f.locator('#send-all-bar')).toBeEnabled(); await f.locator('#send-all-bar').click(); await expect(f.locator('#pending-status')).toHaveText('No changes pending', { timeout: 15000 }); };
const shot = async name => { if (shots) await page.screenshot({ path: shots + '/' + name + '.png' }); };
try {
  await expect(f.locator('#fleet-status')).toHaveText('3 units / 3 live', { timeout: 15000 });
  await tab(/Setup/).click();
  await expect(cell(unit(0), 'connection-status')).toHaveText('Live');
  await expect(cell(unit(2), 'unit-mode')).toHaveText('4K/UHD 1 Ch');
  check('Setup lists three live units with their mode');

  // An input label is staged, then sent, then confirmed by the unit.
  await type(unit(0), 'ChannelName1', 'CAM 13');
  await expect(cell(unit(0), 'ChannelName1')).toHaveAttribute('data-pending', 'true');
  await expect(f.locator('#send-all-bar-count')).toHaveText('1');
  assert.equal(await sim(0, 'eParamID_Vid1_ChannelName'), 'Video 1');
  check('a typed input label is staged in amber and nothing reaches the unit');
  await sendAll();
  assert.equal(await sim(0, 'eParamID_Vid1_ChannelName'), 'CAM 13');
  await expect(cell(unit(0), 'ChannelName1')).toHaveAttribute('data-pending', 'false');
  await expect(cell(unit(0), 'ChannelName1')).toHaveText('CAM 13');
  assert.equal(await staged(unit(0), 'ChannelName1'), '');
  check('Send all writes it, the unit confirms it, and the staged copy is dropped');

  // The page shows an edit before the workspace has answered, and a second edit does not wait for the first.
  await post('/fixture/hold');
  await type(unit(0), 'ChannelName2', 'CAM 14');
  await expect(cell(unit(0), 'ChannelName2')).toHaveText('CAM 14');
  await expect.poll(async () => (await state()).held).toBe(true);
  await type(unit(0), 'ChannelName3', 'CAM 15');
  await expect(cell(unit(0), 'ChannelName3')).toHaveText('CAM 15');
  assert.equal(await staged(unit(0), 'ChannelName2'), '');
  await post('/fixture/release', {});
  await expect.poll(() => staged(unit(0), 'ChannelName3')).toBe('CAM 15');
  assert.equal(await staged(unit(0), 'ChannelName2'), 'CAM 14');
  check('two edits show at once while the first save is still held, and both land when it is released');
  // A save the workspace refuses: the draft stays in the cell, marked, and the plan is unchanged.
  await post('/fixture/hold');
  await type(unit(0), 'ChannelName4', 'CAM 16');
  await expect.poll(async () => (await state()).held).toBe(true);
  await post('/fixture/release', { reject: true });
  await expect(cell(unit(0), 'ChannelName4')).toHaveAttribute('aria-invalid', 'true');
  await expect(f.locator('#error')).toBeVisible();
  assert.equal(await staged(unit(0), 'ChannelName4'), '');
  assert.equal(await staged(unit(0), 'ChannelName2'), 'CAM 14');
  await cell(unit(0), 'ChannelName4').click(); await page.keyboard.press('ControlOrMeta+z');
  await expect(cell(unit(0), 'ChannelName4')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(cell(unit(0), 'ChannelName4')).toHaveText('Video 4');
  check('a refused save keeps the draft marked, leaves other edits alone, and Undo discards it');
  await sendAll();
  assert.equal(await sim(0, 'eParamID_Vid2_ChannelName'), 'CAM 14'); assert.equal(await sim(0, 'eParamID_Vid3_ChannelName'), 'CAM 15');

  // The FS-HDR name is the unit's own name.
  await type(unit(0), 'unit-name', 'Truck A');
  await expect(cell(unit(0), 'unit-name')).toHaveAttribute('data-pending', 'true');
  await sendAll();
  assert.equal(await sim(0, 'eParamID_SystemName'), 'Truck A');
  await expect(cell(unit(0), 'unit-name')).toHaveText('Truck A');
  await type(unit(0), 'unit-name', 'A name that is far too long');
  await expect(cell(unit(0), 'unit-name')).toHaveAttribute('aria-invalid', 'true');
  assert.equal(await staged(unit(0), 'SystemName'), '');
  await cell(unit(0), 'unit-name').click(); await page.keyboard.press('ControlOrMeta+z');
  await expect(cell(unit(0), 'unit-name')).toHaveText('Truck A');
  check('the FS-HDR name is written to the unit, and a name the unit would refuse is caught before it is staged');
  await shot('setup');

  // A settings sheet: rows are channels, named by the input labels.
  await tab(/HDR/).click();
  await expect(cell(unit(0) + '#1', 'row-label')).toHaveText('CAM 13');
  await expect(cell(unit(0) + '#1', 'row-unit')).toHaveText('Truck A');
  await expect(cell(unit(2) + '#0', 'Vid#ColorHDRTransform')).toHaveText('Dynamic LUT');
  await choose(unit(0) + '#1', 'Vid#ColorHDRTransform', 'BBC HLG LUT');
  await expect(cell(unit(0) + '#1', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'true');
  await f.locator('#pending-toggle').click();
  await expect(f.locator('.pending-camera strong')).toHaveText('Truck A · CAM 13');
  await expect(f.locator('.pending-item .change')).toHaveText('Dynamic LUT → BBC HLG LUT');
  await shot('sheet-pending');
  await f.locator('.pending-item button', { hasText: 'Cancel' }).click();
  await expect(cell(unit(0) + '#1', 'Vid#ColorHDRTransform')).toHaveText('Dynamic LUT');
  assert.equal(await sim(0, 'eParamID_Vid1ColorHDRTransform'), '3');
  await f.locator('#pending-close').click();
  check('a dropdown change is listed in Pending sends by FS-HDR name and input label, and Cancel takes it back');

  // Auto send: the committed edit goes by itself.
  await f.locator('#send-auto').click();
  await choose(unit(0) + '#2', 'Vid#ColorHDRTransform', 'BBC HLG LUT');
  await expect.poll(() => sim(0, 'eParamID_Vid2ColorHDRTransform'), { timeout: 10000 }).toBe('1');
  await expect(cell(unit(0) + '#2', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'false');
  await expect(cell(unit(0) + '#2', 'Vid#ColorHDRTransform')).toHaveText('BBC HLG LUT');
  await f.locator('#send-manual').click();
  check('with Auto send on, a committed edit reaches the unit without pressing Send');

  // A change made at the unit shows on the sheet.
  await simSet(1, 'eParamID_Vid3ColorHDRTransform', '4');
  await expect(cell(unit(1) + '#3', 'Vid#ColorHDRTransform')).toHaveText('Off', { timeout: 5000 });
  check('a change made at the unit appears on the sheet');

  // A setting with a prerequisite is locked until the prerequisite is on, and its range is checked as typed.
  await show('Custom Size/Pos'); await show('Custom Size');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-readonly', 'true');
  await choose(unit(0) + '#1', 'Vid#CustomSizePos', 'On');
  await sendAll();
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-readonly', 'false');
  await type(unit(0) + '#1', 'Vid#CustomSize', '250');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-invalid', 'true');
  await cell(unit(0) + '#1', 'Vid#CustomSize').click(); await page.keyboard.press('ControlOrMeta+z');
  await type(unit(0) + '#1', 'Vid#CustomSize', '120');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveText('120.0 %');
  await sendAll();
  assert.equal(String(await sim(0, 'eParamID_Vid1CustomSize')), '1200');
  check('a locked setting unlocks once its prerequisite is sent, an out-of-range number is refused, and 120 is sent as 120.0 %');

  // Master: tick channels, change one cell, send to all of them together.
  await tab(/Master/).click();
  await expect(f.locator('#master-summary')).toHaveText('Editing 0 of 9 channels');
  await expect(cell('master', 'Vid#ColorHDRTransform')).toHaveAttribute('aria-readonly', 'true');
  for (const row of [unit(0) + '#3', unit(0) + '#4', unit(1) + '#1', unit(2) + '#0']) await cell(row, 'master-tick').locator('[role=checkbox]').click();
  await expect(f.locator('#master-summary')).toHaveText('Editing 4 of 9 channels');
  await expect(cell('master', 'row-label')).toHaveText('4 of 9');
  await expect(cell('master', 'Vid#ColorHDRTransform')).toHaveText('Dynamic LUT');
  await choose('master', 'Vid#ColorHDRTransform', 'Colorfront Engine-TV');
  for (const row of [unit(0) + '#3', unit(0) + '#4', unit(1) + '#1', unit(2) + '#0']) { await expect(cell(row, 'Vid#ColorHDRTransform')).toHaveText('Colorfront Engine-TV'); await expect(cell(row, 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'true'); }
  await expect(cell(unit(0) + '#1', 'Vid#ColorHDRTransform')).toHaveText('Dynamic LUT');
  await expect(f.locator('#send-all-bar-count')).toHaveText('4');
  assert.equal(await sim(1, 'eParamID_Vid1ColorHDRTransform'), '3');
  await shot('master-staged');
  await sendAll();
  assert.deepEqual([await sim(0, 'eParamID_Vid3ColorHDRTransform'), await sim(0, 'eParamID_Vid4ColorHDRTransform'), await sim(1, 'eParamID_Vid1ColorHDRTransform'), await sim(2, 'eParamID_Vid0ColorHDRTransform')], ['8', '8', '8', '8']);
  assert.equal(await sim(0, 'eParamID_Vid1ColorHDRTransform'), '3');
  check('one Master edit stages on the four ticked channels only, and Send all writes all four across three units');
  await f.locator('#master-all').click();
  await expect(f.locator('#master-summary')).toHaveText('Editing 9 of 9 channels');
  await expect(cell('master', 'Vid#ColorHDRTransform')).toHaveText('Mixed');
  await f.locator('#send-auto').click();
  await choose('master', 'Vid#ColorHDRTransform', 'BBC HLG LUT');
  await expect.poll(async () => (await Promise.all([[0, 1], [0, 2], [0, 3], [0, 4], [1, 1], [1, 2], [1, 3], [1, 4], [2, 0]].map(([index, channel]) => sim(index, 'eParamID_Vid' + channel + 'ColorHDRTransform')))).join(''), { timeout: 15000 }).toBe('111111111');
  await expect(cell('master', 'Vid#ColorHDRTransform')).toHaveText('BBC HLG LUT');
  await f.locator('#send-manual').click();
  await f.locator('#master-none').click();
  check('Select all shows Mixed where channels differ, and with Auto send on one Master edit reaches all nine channels');

  // Channels in columns, a new sheet, and a unit that isn't there.
  await tab(/HDR/).click();
  await f.locator('#view-columns').click();
  await expect(f.locator('#grid-channels')).toHaveAttribute('data-orientation', 'columns');
  await expect(cell('Vid#ColorHDRTransform', unit(0) + '#1')).toHaveText('BBC HLG LUT');
  await shot('sheet-columns');
  await f.locator('#view-rows').click();
  await f.getByRole('button', { name: 'Add sheet' }).click();
  const dialog = f.getByRole('dialog', { name: 'New sheet' });
  await dialog.getByRole('textbox', { name: 'Sheet name' }).fill('Framing');
  await dialog.getByRole('button', { name: 'Create sheet' }).click();
  await expect(tab(/Framing/)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveText('120.0 %');
  check('channels can be turned into columns, and a new sheet starts as a copy of the open one');
  await tab(/Setup/).click();
  await f.locator('#unit-count').fill('4'); await f.locator('#unit-count').press('Enter');
  await expect.poll(async () => (await state()).document.units.length).toBe(4);
  const added = (await state()).document.units[3].id;
  await type(added, 'unit-host', '127.0.0.1:9');
  await expect(cell(added, 'connection-status')).toHaveText('Offline', { timeout: 15000 });
  await tab(/HDR/).click();
  await expect(cell(added + '#-', 'row-signal')).toHaveText('Offline');
  await expect(cell(added + '#-', 'Vid#ColorHDRTransform')).toHaveAttribute('aria-readonly', 'true');
  await shot('sheet-offline');
  check('a fourth unit that does not answer shows Offline with one blank, locked row');
  assert.deepEqual(errors, []);
  console.log('PASS');
} catch (error) { await shot('failure'); console.log('ERRORS', errors); console.log('STATE', JSON.stringify((await state()).logs).slice(0, 800)); throw error; }
finally { await browser.close(); }
