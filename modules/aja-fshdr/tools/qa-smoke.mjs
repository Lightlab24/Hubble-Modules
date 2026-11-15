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
// On a slider cell the number is what opens for typing; a double press on the track only moves the slider.
async function type(row, column, value) { await cell(row, column).scrollIntoViewIfNeeded(); const number = cell(row, column).locator('.hubble-slider-value'); await ((await number.count()) ? number : cell(row, column)).dblclick(); const input = cell(row, column).locator('input.cell-input'); await expect(input).toBeVisible(); await input.fill(value); await input.press('Enter'); }
async function choose(row, column, label) { await cell(row, column).scrollIntoViewIfNeeded(); await cell(row, column).click(); await page.keyboard.press('Enter'); await f.getByRole('option', { name: label, exact: true }).click(); }
async function show(label) { await f.locator('.toolbar [data-for]:not([hidden]) button[aria-label="Choose visible columns"]').click(); const search = f.getByRole('searchbox', { name: 'Search columns' }); await search.fill(label); await f.getByRole('menuitemcheckbox', { name: label, exact: true }).click(); await search.press('Escape'); }
const sendAll = async () => { await expect(f.locator('#send-all-bar')).toBeEnabled(); await f.locator('#send-all-bar').click(); await expect(f.locator('#pending-status')).toHaveText('No changes pending', { timeout: 15000 }); };
const number = (row, column) => cell(row, column).locator('.hubble-slider-value');
const reading = async (row, column) => Number((await number(row, column).textContent()).replace(/\s*%$/, ''));
/** Clicks a cell's edge, outside its slider, so it becomes the active cell. A slider only moves once its cell is active. */
async function selectCell(row, column) { await cell(row, column).scrollIntoViewIfNeeded(); const box = await cell(row, column).boundingBox(); await page.mouse.click(box.x + 3, box.y + 3); await expect(cell(row, column)).toHaveAttribute('data-hubble-spreadsheet-active', 'true'); }
/** A real pointer drag along a slider's track, from one fraction of its length to another, after making its cell active. */
async function drag(row, column, from, to) {
  await selectCell(row, column);
  const box = await cell(row, column).locator('.hubble-slider-root').boundingBox(), y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y); await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width * (from + (to - from) * step / 8), y);
  await page.mouse.up();
}
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

  // The unit's own page greys out Custom Size while Custom Size/Pos is off, but the unit takes it, so it stays editable here. Its range is checked as typed.
  await show('Custom Size/Pos'); await show('Custom Size');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-readonly', 'false');
  await choose(unit(0) + '#1', 'Vid#CustomSizePos', 'On');
  await sendAll();
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-readonly', 'false');
  await type(unit(0) + '#1', 'Vid#CustomSize', '250');
  await expect(cell(unit(0) + '#1', 'Vid#CustomSize')).toHaveAttribute('aria-invalid', 'true');
  await cell(unit(0) + '#1', 'Vid#CustomSize').click(); await page.keyboard.press('ControlOrMeta+z');
  await type(unit(0) + '#1', 'Vid#CustomSize', '120');
  await expect(number(unit(0) + '#1', 'Vid#CustomSize')).toHaveText('120.0 %');
  await sendAll();
  assert.equal(String(await sim(0, 'eParamID_Vid1CustomSize')), '1200');
  check('Custom Size stays editable with Custom Size/Pos off, an out-of-range number is refused, and 120 is sent as 120.0 %');

  // Framing settings in % are sliders with their number. A drag stages one value on release, and nothing reaches the unit until it is sent.
  await show('Custom H Pos'); await show('ROI Left');
  const ch1 = unit(0) + '#1';
  await expect(cell(ch1, 'Vid#CustomHPosition').getByRole('slider')).toHaveAttribute('aria-valuemin', '-100');
  await expect(number(ch1, 'Vid#CustomHPosition')).toHaveText('0.0 %');
  await expect(cell(unit(1) + '#1', 'Vid#ROILeft').getByRole('slider')).toHaveAttribute('data-disabled', '');
  await drag(ch1, 'Vid#CustomHPosition', 0.5, 0.8);
  const moved = await reading(ch1, 'Vid#CustomHPosition');
  assert.ok(moved > 0, 'the drag moved H Pos right: ' + moved);
  await expect(cell(ch1, 'Vid#CustomHPosition')).toHaveAttribute('data-pending', 'true');
  assert.equal(await staged(ch1, 'Vid#CustomHPosition'), moved.toFixed(1));
  assert.equal(String(await sim(0, 'eParamID_Vid1CustomHPosition')), '0');
  await expect(f.locator('.sheet-scroll:not([hidden]) [data-hubble-spreadsheet-active="true"]')).toHaveAttribute('data-hubble-column', 'Vid#CustomHPosition');
  await expect(f.locator('#grid-channels')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(f.locator('.sheet-scroll:not([hidden]) [data-hubble-spreadsheet-active="true"]')).toHaveAttribute('data-hubble-column', 'Vid#CustomSize');
  await shot('slider-staged');
  check('a slider drag stages one value in amber, the number follows it, the unit is untouched, and the arrow keys still move around the sheet');
  // A locked slider doesn't move, and neither do its − and +. ROI Left waits for Region Of Interest.
  await drag(unit(1) + '#1', 'Vid#ROILeft', 0.5, 0.2);
  await expect(number(unit(1) + '#1', 'Vid#ROILeft')).toHaveText('100.0 %');
  await expect(cell(unit(1) + '#1', 'Vid#ROILeft').locator('.slider-step')).toHaveCount(2);
  for (const step of await cell(unit(1) + '#1', 'Vid#ROILeft').locator('.slider-step').all()) await expect(step).toBeDisabled();
  assert.equal(await staged(unit(1) + '#1', 'Vid#ROILeft'), '');
  check('a slider locked by its prerequisite does not move, and its − and + are off');
  await sendAll();
  assert.equal(String(await sim(0, 'eParamID_Vid1CustomHPosition')), String(Math.round(moved * 10)));
  await expect(number(ch1, 'Vid#CustomHPosition')).toHaveText(moved.toFixed(1) + ' %');
  check('Send all writes the slider value and the unit confirms it');
  // The page shows a drag before the workspace has answered, and a second drag does not wait for it.
  await post('/fixture/hold');
  await drag(ch1, 'Vid#CustomHPosition', 0.5, 0.2);
  const left = await reading(ch1, 'Vid#CustomHPosition');
  assert.ok(left < 0, 'the drag moved H Pos left: ' + left);
  await expect.poll(async () => (await state()).held).toBe(true);
  await drag(ch1, 'Vid#CustomSize', 0.3, 0.1);
  const smaller = await reading(ch1, 'Vid#CustomSize');
  assert.ok(smaller < 120, 'the drag made Custom Size smaller: ' + smaller);
  await post('/fixture/release', {});
  await expect.poll(() => staged(ch1, 'Vid#CustomSize')).toBe(smaller.toFixed(1));
  assert.equal(await staged(ch1, 'Vid#CustomHPosition'), left.toFixed(1));
  check('two drags show at once while the first save is still held, and both land when it is released');
  // Typing still gives an exact value.
  await type(ch1, 'Vid#CustomHPosition', '-12.5');
  await expect(number(ch1, 'Vid#CustomHPosition')).toHaveText('-12.5 %');
  assert.equal(await staged(ch1, 'Vid#CustomHPosition'), '-12.5');
  await sendAll();
  assert.equal(String(await sim(0, 'eParamID_Vid1CustomHPosition')), '-125');
  check('double-clicking the number types an exact value, and it is sent');
  // With Auto send on, the value goes when the slider is let go.
  await f.locator('#send-auto').click();
  await drag(ch1, 'Vid#CustomSize', 0.4, 0.6);
  const sent = await reading(ch1, 'Vid#CustomSize');
  await expect.poll(async () => String(await sim(0, 'eParamID_Vid1CustomSize')), { timeout: 10000 }).toBe(String(Math.round(sent * 10)));
  await expect(cell(ch1, 'Vid#CustomSize')).toHaveAttribute('data-pending', 'false');
  await f.locator('#send-manual').click();
  check('with Auto send on, letting go of the slider sends its value');
  // A change at the unit moves the slider.
  await simSet(0, 'eParamID_Vid1CustomHPosition', '250');
  await expect(number(ch1, 'Vid#CustomHPosition')).toHaveText('25.0 %', { timeout: 5000 });
  check('a change made at the unit moves the slider and its number');
  await type(ch1, 'Vid#CustomSize', '120'); await sendAll();

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
  // With channels in columns, the slider is in the same cell, turned with it. Channel 1 is first, so the sheet goes back to its left edge, clear of the frozen setting names.
  await f.locator('#viewport-channels').evaluate(viewport => { viewport.scrollLeft = 0; });
  await drag('Vid#CustomHPosition', unit(0) + '#1', 0.5, 0.75);
  const across = await reading('Vid#CustomHPosition', unit(0) + '#1');
  assert.ok(across > 0, 'the drag moved H Pos right: ' + across);
  assert.equal(await staged(unit(0) + '#1', 'Vid#CustomHPosition'), across.toFixed(1));
  await shot('sheet-columns');
  await f.locator('#pending-toggle').click(); await f.locator('.pending-item button', { hasText: 'Cancel' }).click(); await f.locator('#pending-close').click();
  await expect(number('Vid#CustomHPosition', unit(0) + '#1')).toHaveText('25.0 %');
  check('with channels in columns the slider drags and stages the same way');
  await f.locator('#view-rows').click();
  await f.getByRole('button', { name: 'Add sheet' }).click();
  const dialog = f.getByRole('dialog', { name: 'New sheet' });
  await dialog.getByRole('textbox', { name: 'Sheet name' }).fill('Framing');
  await dialog.getByRole('button', { name: 'Create sheet' }).click();
  await expect(tab(/Framing/)).toHaveAttribute('aria-selected', 'true');
  await expect(number(unit(0) + '#1', 'Vid#CustomSize')).toHaveText('120.0 %');
  check('channels can be turned into columns, and a new sheet starts as a copy of the open one');
  // Master: a Mixed slider cell stays text until a value is typed, then one drag stages on every ticked channel.
  await simSet(1, 'eParamID_Vid1CustomSizePos', '1');
  await tab(/Master/).click();
  await show('Custom H Pos');
  for (const row of [unit(0) + '#1', unit(1) + '#1']) await cell(row, 'master-tick').locator('[role=checkbox]').click();
  await expect(cell('master', 'Vid#CustomHPosition')).toHaveText('Mixed');
  await expect(cell('master', 'Vid#CustomHPosition').getByRole('slider')).toHaveCount(0);
  await type('master', 'Vid#CustomHPosition', '10');
  await expect(number('master', 'Vid#CustomHPosition')).toHaveText('10.0 %');
  await drag('master', 'Vid#CustomHPosition', 0.55, 0.3);
  const together = await reading('master', 'Vid#CustomHPosition');
  assert.ok(together < 10, 'the Master drag moved H Pos left: ' + together);
  for (const row of [unit(0) + '#1', unit(1) + '#1']) { assert.equal(await staged(row, 'Vid#CustomHPosition'), together.toFixed(1)); await expect(cell(row, 'Vid#CustomHPosition')).toHaveAttribute('data-pending', 'true'); }
  assert.equal(String(await sim(1, 'eParamID_Vid1CustomHPosition')), '0');
  await shot('master-slider');
  await sendAll();
  assert.deepEqual([String(await sim(0, 'eParamID_Vid1CustomHPosition')), String(await sim(1, 'eParamID_Vid1CustomHPosition'))], [String(Math.round(together * 10)), String(Math.round(together * 10))]);
  await f.locator('#master-none').click();
  check('a Mixed Master cell stays text until typed, then one Master drag stages on both ticked channels and Send all writes both units');
  // A unit that isn't connected takes presets: labels in Setup, settings on its sheet rows, sliders included.
  await tab(/Setup/).click();
  await f.locator('#unit-count').fill('4'); await f.locator('#unit-count').press('Enter');
  await expect.poll(async () => (await state()).document.units.length).toBe(4);
  const added = (await state()).document.units[3].id;
  await type(added, 'unit-host', '127.0.0.1:9');
  await expect(cell(added, 'connection-status')).toHaveText('Offline', { timeout: 15000 });
  await type(added, 'ChannelName1', 'CAM 21');
  await expect(cell(added, 'ChannelName1')).toHaveAttribute('data-pending', 'true');
  // The rows follow the mode it is planned in, at once.
  await choose(added, 'unit-mode', '4K/UHD 1 Ch');
  await tab(/HDR/).click();
  await expect(cell(added + '#0', 'row-signal')).toHaveText('Offline');
  await expect(cell(added + '#1', 'row-signal')).toHaveCount(0);
  await tab(/Setup/).click(); await choose(added, 'unit-mode', 'HD/SD 4 Ch');
  await tab(/HDR/).click();
  await expect(cell(added + '#1', 'row-signal')).toHaveText('Offline');
  await expect(cell(added + '#1', 'row-label')).toHaveText('CAM 21');
  await expect(cell(added + '#1', 'Vid#ColorHDRTransform')).toHaveAttribute('aria-readonly', 'false');
  await choose(added + '#1', 'Vid#ColorHDRTransform', 'BBC HLG LUT');
  await expect(cell(added + '#1', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'true');
  // Custom Size goes in before the setting that switches it on. Its slider appears once it has a value.
  await type(added + '#1', 'Vid#CustomSize', '110');
  await expect(number(added + '#1', 'Vid#CustomSize')).toHaveText('110.0 %');
  await choose(added + '#1', 'Vid#CustomSizePos', 'On');
  await f.locator('#pending-toggle').click();
  await expect(f.locator('.pending-item[data-row-id="' + added + '#1"][data-setting-id="Vid#ColorHDRTransform"] .status')).toHaveText('Sends after FS-HDR 4 connects');
  await expect(f.locator('#pending-summary')).toContainText('4 presets wait for an FS-HDR to connect');
  await expect(f.locator('#send-all-bar')).toBeDisabled();
  await shot('presets-waiting');
  await f.locator('#pending-close').click();
  check('a unit that is not connected takes presets in Setup and on its sheet rows, its rows follow the mode it is planned in, and Pending sends holds them');
  // When it connects, the presets stay staged and go with Send all, Custom Size included.
  await tab(/Setup/).click();
  await type(added, 'unit-host', hosts[3]);
  await expect(cell(added, 'connection-status')).toHaveText('Live', { timeout: 15000 });
  assert.equal(await sim(3, 'eParamID_Vid1ColorHDRTransform'), '3', 'connecting sends nothing by itself');
  await tab(/HDR/).click();
  await expect(cell(added + '#1', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'true');
  await sendAll();
  assert.deepEqual([await sim(3, 'eParamID_Vid1ColorHDRTransform'), await sim(3, 'eParamID_Vid1CustomSizePos'), String(await sim(3, 'eParamID_Vid1CustomSize')), await sim(3, 'eParamID_Vid1_ChannelName')], ['1', '1', '1100', 'CAM 21']);
  await expect(cell(added + '#1', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'false');
  check('once it connects the presets stay staged until Send all, which writes them all, a setting after its prerequisite');

  // A simulated unit: ticked in Setup it is live with no address and takes sends. Turned off, what was set on it stays as presets.
  await tab(/Setup/).click();
  await f.locator('#unit-count').fill('5'); await f.locator('#unit-count').press('Enter');
  await expect.poll(async () => (await state()).document.units.length).toBe(5);
  const simulated = (await state()).document.units[4].id;
  await cell(simulated, 'unit-simulated').locator('[role=checkbox]').click();
  await expect(cell(simulated, 'connection-status')).toHaveText('Simulated', { timeout: 10000 });
  await expect(f.locator('#fleet-status')).toHaveText('5 units / 4 live · 1 simulated');
  await shot('setup-simulated');
  await tab(/HDR/).click();
  await expect(cell(simulated + '#2', 'row-signal')).toHaveText('Simulated');
  await choose(simulated + '#2', 'Vid#ColorHDRTransform', 'Colorfront Engine-TV');
  await sendAll();
  await expect(cell(simulated + '#2', 'Vid#ColorHDRTransform')).toHaveText('Colorfront Engine-TV');
  await expect(cell(simulated + '#2', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'false');
  assert.equal((await state()).simulated.units[simulated]?.eParamID_Vid2ColorHDRTransform, '8', 'the simulated unit’s settings are saved in the workspace');
  check('a ticked Simulated unit is live with no address, takes a send and confirms it, and its settings are saved');
  await tab(/Setup/).click();
  await cell(simulated, 'unit-simulated').locator('[role=checkbox]').click();
  await expect(cell(simulated, 'connection-status')).toHaveText('');
  await tab(/HDR/).click();
  await expect(cell(simulated + '#2', 'row-signal')).toHaveText('Not connected');
  await expect(cell(simulated + '#2', 'Vid#ColorHDRTransform')).toHaveText('Colorfront Engine-TV');
  await expect(cell(simulated + '#2', 'Vid#ColorHDRTransform')).toHaveAttribute('data-pending', 'true');
  assert.equal(await staged(simulated + '#2', 'Vid#ColorHDRTransform'), '8');
  await expect.poll(async () => JSON.stringify((await state()).simulated.units)).toBe('{}');
  await shot('simulated-to-presets');
  check('turning Simulated off keeps what was set on it as presets for the real unit');
  assert.deepEqual(errors, []);
  console.log('PASS');
} catch (error) { await shot('failure'); console.log('ERRORS', errors); console.log('STATE', JSON.stringify((await state()).logs).slice(0, 800)); throw error; }
finally { await browser.close(); }
