import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const use = (row: Locator, axis: string) => row.locator(`[data-lens-axis="${axis}"] [role="checkbox"]`);
const field = (row: Locator, name: string) => row.locator(`[data-field="${name}"]`);
const cell = (row: Locator, column: string) => row.locator(`[data-column="${column}"]`);

async function lensParams(request: APIRequestContext) {
  const { config } = await (await request.get('/__inspect')).json();
  return Object.values(config.Camera as Record<string, { LensParams?: string }>).map(camera => camera.LensParams ?? '');
}
async function type(row: Locator, name: string, value: string) {
  await field(row, name).fill(value);
  await field(row, name).press('Enter');
}
async function choose(frame: FrameLocator, row: Locator, column: string, label: string) {
  await cell(row, column).click();
  await frame.getByRole('grid').press('Enter');
  await frame.getByRole('dialog').getByRole('option', { name: label, exact: true }).click();
}
// The count box adds a row at the end; the Add camera menu it replaced also chose the model.
async function addCamera(frame: FrameLocator, group: Locator, model: string) {
  const rows = group.locator('tbody tr[data-id]'), before = await rows.count();
  await group.locator('[data-count-step="1"]').click();
  await expect(rows).toHaveCount(before + 1);
  const added = rows.last();
  if (!(await cell(added, 'model').innerText()).includes(model)) await choose(frame, added, 'model', model);
  await expect(cell(added, 'model')).toContainText(model);
}
// A real controller, a camera the controller knows about, and a Tilta lens already sent.
async function sentCamera(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-device-view="details"]').click();
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), row = group.locator('tr[data-id]').first();
  await addCamera(f, group, 'Alpha-USB');
  await expect(row).toBeVisible();
  await choose(f, row, 'lens', 'Tilta - Nucleus-M');
  const send = group.locator('[data-action="send-controller"]');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  return { f, group, row, send, sheet: group.getByRole('grid') };
}

test('ticking Use Iris fills nothing in and uses the host checkbox', async ({ page, request }) => {
  const { group, row } = await sentCamera(page, request);
  await expect(group.locator('th[data-field-header="irisSummary"]')).toHaveText('Use Iris');
  const iris = use(row, 'iris');
  await expect(iris).toHaveClass(/hubble-spreadsheet-checkbox/);
  await expect(iris).not.toBeChecked();
  const size = await iris.evaluate(element => { const box = element.getBoundingClientRect(); return [box.width, box.height, getComputedStyle(element).paddingLeft]; });
  expect(size).toEqual([18, 18, '0px']);

  await iris.click();
  await expect(iris).toBeChecked();
  for (const name of ['irisMotor', 'irisMin', 'irisMax']) {
    await expect(field(row, name)).toBeEnabled();
    await expect(field(row, name)).toHaveValue('');
    await expect(cell(row, name)).not.toHaveClass(/hc-changed/);
  }
  await expect(cell(row, 'irisSummary')).toHaveText('');
  await expect(cell(row, 'sync')).toHaveText('In sync');
});

test('an axis waits until it is whole, then Delete and Send take it back off the controller', async ({ page, request }) => {
  const { group, row, send, sheet } = await sentCamera(page, request);
  await use(row, 'iris').click();
  await type(row, 'irisMotor', '7');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Incomplete');
  expect(await lensParams(request)).toEqual(['']);
  await type(row, 'irisMin', '2.8');
  await type(row, 'irisMax', '22');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['7:I:2.8:22']);

  await cell(row, 'irisMotor').click();
  await cell(row, 'irisMax').click({ modifiers: ['Shift'] });
  await sheet.press('Delete');
  for (const name of ['irisMotor', 'irisMin', 'irisMax']) await expect(field(row, name)).toHaveValue('');
  await expect(cell(row, 'irisMotor')).toHaveClass(/hc-changed/);
  expect(await lensParams(request)).toEqual(['7:I:2.8:22']);
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['']);
  await expect(group.locator('[data-action="send-controller"] span')).toHaveText('0');
});

test('deleting one motor setting clears it from the controller too', async ({ page, request }) => {
  const { row, send, sheet } = await sentCamera(page, request);
  const fill = async () => {
    await type(row, 'irisMotor', '7');
    await type(row, 'irisMin', '2.8');
    await type(row, 'irisMax', '22');
    await send.click();
    await expect(cell(row, 'sync')).toHaveText('Verified');
    expect(await lensParams(request)).toEqual(['7:I:2.8:22']);
  };
  await use(row, 'iris').click();
  await fill();

  // Without a motor there is no entry left, and the sheet says so.
  await cell(row, 'irisMotor').click();
  await sheet.press('Delete');
  await expect(field(row, 'irisMin')).toHaveValue('2.8');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['']);
  await expect(field(row, 'irisMin')).toHaveValue('');
  await expect(field(row, 'irisMax')).toHaveValue('');

  // A Tilta iris can lose its limits and keep the motor.
  await fill();
  await cell(row, 'irisMin').click();
  await sheet.press('Delete');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['7:I']);
  await expect(field(row, 'irisMotor')).toHaveValue('7');
  await expect(field(row, 'irisMax')).toHaveValue('');
});

test('a Tilta iris is reversed from its Direction cell, which swaps Open and Closed', async ({ page, request }) => {
  const { f, row, send, sheet } = await sentCamera(page, request);
  await use(row, 'iris').click();
  // The cell is live for a Tilta, and with no numbers there is nothing to say or swap.
  await expect(cell(row, 'irisDirection')).not.toHaveClass(/hc-axis-inactive/);
  await expect(cell(row, 'irisTorque')).toHaveClass(/hc-axis-inactive/);
  await expect(field(row, 'irisDirection')).toHaveText('');
  await type(row, 'irisMotor', '7');
  await type(row, 'irisMin', '2.8');
  await type(row, 'irisMax', '22');
  await expect(field(row, 'irisDirection')).toHaveText('Normal');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['7:I:2.8:22']);

  // Picking the direction it already has changes nothing.
  await choose(f, row, 'irisDirection', 'Normal');
  await expect(field(row, 'irisMin')).toHaveValue('2.8');
  await expect(cell(row, 'irisMin')).not.toHaveClass(/hc-changed/);

  await choose(f, row, 'irisDirection', 'Swapped');
  await expect(field(row, 'irisMin')).toHaveValue('22');
  await expect(field(row, 'irisMax')).toHaveValue('2.8');
  await expect(field(row, 'irisDirection')).toHaveText('Swapped');
  await expect(cell(row, 'irisMin')).toHaveClass(/hc-changed/);
  await expect(cell(row, 'irisMax')).toHaveClass(/hc-changed/);
  await expect(field(row, 'irisMotor')).toHaveValue('7');
  expect(await lensParams(request)).toEqual(['7:I:2.8:22']);
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['7:I:22:2.8']);
  await expect(field(row, 'irisDirection')).toHaveText('Swapped');

  // Undo puts the numbers back, and the cell follows them.
  await choose(f, row, 'irisDirection', 'Normal');
  await expect(field(row, 'irisMin')).toHaveValue('2.8');
  await expect(field(row, 'irisDirection')).toHaveText('Normal');
  await sheet.press('ControlOrMeta+z');
  await expect(field(row, 'irisMin')).toHaveValue('22');
  await expect(field(row, 'irisMax')).toHaveValue('2.8');
  await expect(field(row, 'irisDirection')).toHaveText('Swapped');

  // Typing the numbers the other way round is the same thing, and sends.
  await type(row, 'irisMin', '4');
  await type(row, 'irisMax', '16');
  await expect(field(row, 'irisDirection')).toHaveText('Normal');
  await type(row, 'irisMin', '16');
  await type(row, 'irisMax', '4');
  await expect(field(row, 'irisDirection')).toHaveText('Swapped');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['7:I:16:4']);
});

test('deleting Lens connection goes to None and Send reports when the controller has no disconnect', async ({ page, request }) => {
  const { f, row, send, sheet } = await sentCamera(page, request);
  const port = async () => {
    const { config } = await (await request.get('/__inspect')).json();
    return (Object.values(config.Camera)[0] as { LensInterface?: { port?: unknown } }).LensInterface?.port ?? null;
  };
  await cell(row, 'connection').click();
  await sheet.press('Enter');
  const list = f.getByRole('dialog').getByRole('option');
  await expect(list.nth(1)).toBeVisible();
  const label = (await list.nth(1).textContent())!.trim();
  await list.nth(1).click();
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await port()).not.toBeNull();

  await cell(row, 'connection').click();
  await sheet.press('Delete');
  await expect(field(row, 'lensPort')).toHaveText('None');
  expect(label).not.toBe('None');
  // No captured controller has shown a disconnect choice, so this simulator offers none and nothing is guessed.
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Error');
  await expect(f.locator('.hc-toast, [data-role="toast"]').first()).toContainText('disconnect');
  expect(await port()).not.toBeNull();
  await expect(field(row, 'lensPort')).toHaveText('None');
});

test('Delete turns Use off, and across the settings it clears them too', async ({ page, request }) => {
  const { group, row, send, sheet } = await sentCamera(page, request);
  await use(row, 'iris').click();
  await type(row, 'irisMotor', '7');
  await type(row, 'irisMin', '2.8');
  await type(row, 'irisMax', '22');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');

  // On its own it only turns the box off and leaves the controller alone.
  await cell(row, 'connection').click();
  await sheet.press('ArrowRight');
  await expect(group.locator('[data-camera-location]')).toHaveText(/Use Iris$/);
  await expect(group.locator('[data-camera-value]')).toHaveText('On');
  await sheet.press('Delete');
  await expect(use(row, 'iris')).not.toBeChecked();
  await expect(send).toBeDisabled();
  expect(await lensParams(request)).toEqual(['7:I:2.8:22']);

  await sheet.press(' ');
  await expect(use(row, 'iris')).toBeChecked();
  await expect(field(row, 'irisMotor')).toHaveValue('7');
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');

  // Across the box and its settings, Send takes the axis off.
  await cell(row, 'connection').click();
  await sheet.press('ArrowRight');
  await sheet.press('Shift+ArrowRight');
  await sheet.press('Shift+ArrowRight');
  await sheet.press('Shift+ArrowRight');
  await sheet.press('Delete');
  await expect(use(row, 'iris')).not.toBeChecked();
  await send.click();
  await expect(cell(row, 'sync')).toHaveText('Verified');
  expect(await lensParams(request)).toEqual(['']);
});

test('Delete on Lens model and Lens connection clears them, and undo restores everything', async ({ page, request }) => {
  const { f, row, sheet } = await sentCamera(page, request);
  await use(row, 'iris').click();
  await type(row, 'irisMotor', '7');
  await cell(row, 'lens').click();
  await sheet.press('Delete');
  await expect(field(row, 'lens')).toHaveText('None');
  await expect(cell(row, 'irisSummary')).toHaveText('—');
  await expect(use(row, 'iris')).toHaveCount(0);

  await sheet.press('ControlOrMeta+z');
  await expect(field(row, 'lens')).toHaveText('Tilta - Nucleus-M');
  await expect(use(row, 'iris')).toBeChecked();
  await expect(field(row, 'irisMotor')).toHaveValue('7');

  await sheet.press('ControlOrMeta+Shift+z');
  await expect(field(row, 'lens')).toHaveText('None');

  // Choosing a lens again starts clean.
  await choose(f, row, 'lens', 'Tilta - Nucleus-M');
  await expect(use(row, 'iris')).not.toBeChecked();
  await use(row, 'iris').click();
  await expect(field(row, 'irisMotor')).toHaveValue('');
});

test('values an earlier version made up are gone on load, and ones in use stay', async ({ page, request }) => {
  const { row } = await sentCamera(page, request);
  await expect.poll(async () => {
    const reply = await request.post('/__rpc', { data: { operation: 'call', commandId: 'read-plan', value: null } });
    return (await reply.json()).result.plan?.cameras?.length;
  }).toBeGreaterThan(0);
  const { result } = await (await request.post('/__rpc', { data: { operation: 'call', commandId: 'read-plan', value: null } })).json();
  const made = { irisMotor: '3', irisMin: '1.6', irisMax: '32', zoomMotor: '5', focusMotor: '2' };
  Object.assign(result.plan.cameras[0], made, { enabledLensAxes: ['zoom'], dirty: [] });
  const saved = await request.post('/__rpc', { data: { operation: 'call', commandId: 'save-plan', value: { revision: result.revision, plan: result.plan } } });
  expect((await saved.json()).error).toBeUndefined();

  await page.reload();
  const f = ui(page);
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  await f.getByRole('button', { name: 'Expand Zoom', exact: true }).click();
  await use(row, 'iris').click();
  await expect(use(row, 'iris')).toBeChecked();
  await expect(field(row, 'irisMotor')).toHaveValue('');
  await expect(field(row, 'irisMax')).toHaveValue('');
  await expect(use(row, 'zoom')).toBeChecked();
  await expect(field(row, 'zoomMotor')).toHaveValue('5');
});

test('Delete turns Camera Control Enabled off', async ({ page, request }) => {
  const { row, sheet } = await sentCamera(page, request);
  const enabled = row.locator('[data-field="controlEnabled"] [role="checkbox"]');
  await expect(enabled).toHaveClass(/hubble-spreadsheet-checkbox/);
  await enabled.click();
  await expect(enabled).toBeChecked();
  await cell(row, 'name').click();
  await sheet.press('ArrowRight');
  while (!(await cell(row, 'controlEnabled').getAttribute('data-hubble-spreadsheet-active'))) await sheet.press('ArrowRight');
  await sheet.press('Delete');
  await expect(enabled).not.toBeChecked();
});

test('a dropdown with a known list opens without waiting for the controller', async ({ page, request }) => {
  const { f, row, sheet } = await sentCamera(page, request);
  const held: { continue(): Promise<void> }[] = [];
  await page.route('**/__rpc', route => {
    if (route.request().postDataJSON()?.commandId === 'options') held.push(route); else void route.continue();
  });

  await cell(row, 'lens').click();
  const started = Date.now();
  await sheet.press('Enter');
  await expect(f.getByRole('dialog').getByRole('option', { name: 'ARRI - cforce', exact: true })).toBeVisible();
  const elapsed = Date.now() - started;
  console.log('Lens model list visible after', elapsed, 'ms with the controller not answering');
  expect(elapsed).toBeLessThan(500);
  await expect.poll(() => held.length).toBe(1);
  await page.keyboard.press('Escape');

  // Nothing has ever listed this lens's connections, so that one has to ask.
  await cell(row, 'connection').click();
  await sheet.press('Enter');
  await expect(f.getByRole('dialog').getByText('Loading choices…')).toBeVisible();
  await expect.poll(() => held.length).toBe(2);
  await Promise.all(held.splice(0).map(route => route.continue()));
  await expect(f.getByRole('dialog').getByRole('option', { name: 'None', exact: true })).toBeVisible({ timeout: 4000 });
  await page.unroute('**/__rpc');
});

test('an offline controller never holds a dropdown up', async ({ page, request }) => {
  const { f, group, row, sheet } = await sentCamera(page, request);
  await request.post('/__simulate', { data: { closeBroker: true } });
  await expect(group.locator('.hc-controller-header > .hc-status')).toHaveText('Offline', { timeout: 15000 });
  let asked = 0;
  await page.route('**/__rpc', route => { if (route.request().postDataJSON()?.commandId === 'options') asked++; void route.continue(); });

  for (const [column, option] of [['lens', 'ARRI - cforce'], ['connection', 'None']] as const) {
    await cell(row, column).click();
    const started = Date.now();
    await sheet.press('Enter');
    await expect(f.getByRole('dialog').getByRole('option', { name: option, exact: true })).toBeVisible();
    const elapsed = Date.now() - started;
    console.log(column, 'list visible after', elapsed, 'ms with the controller offline');
    expect(elapsed).toBeLessThan(500);
    await page.keyboard.press('Escape');
  }
  expect(asked).toBe(0);
  await page.unroute('**/__rpc');
});
