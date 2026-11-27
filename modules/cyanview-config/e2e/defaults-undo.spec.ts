import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// The Defaults tab's two tables on Hubble's grid, with the undo Hubble keeps for each
// (module-spreadsheet-history-v1), driven with real clicks and keys. It needs Hubble's shared controls
// with grid undo: point CYANVIEW_RENDERER_ASSETS at a Hubble that has it. On an older Hubble the tables
// have no undo, as before, and these are skipped.

const ui = (page: Page) => page.frameLocator('iframe');
const tab = (f: FrameLocator) => f.locator('#hc-defaults');
const box = (f: FrameLocator, name: string) => tab(f).getByRole('textbox', { name, exact: true });
const grid = (f: FrameLocator, table: 'devices' | 'types') => tab(f).locator('[data-defaults-grid="' + table + '"]');
const deviceCell = (f: FrameLocator, kind: string, column: string) => grid(f, 'devices').locator('td[data-hubble-row="' + kind + '"][data-hubble-column="' + column + '"]');
const typeRows = (f: FrameLocator) => grid(f, 'types').locator('tbody tr[data-defaults-type]');
const UNDO = 'ControlOrMeta+z', REDO = 'ControlOrMeta+Shift+z';
const plan = async (request: APIRequestContext) => (await (await request.post('/__rpc', { data: { commandId: 'read-plan', value: null } })).json()).result.plan;

async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true, defaults: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="defaults"]').click();
  await expect(tab(f)).toBeVisible();
  await expect(grid(f, 'devices')).toBeVisible();
  return f;
}

test.beforeEach(async ({ request }) => {
  const runtime = await (await request.get('/api/module-controls/spreadsheet-v1.js')).text();
  test.skip(!runtime.includes('historySupported'), 'These shared controls have no grid undo');
});

test('a device pattern typed or cleared undoes and redoes, and is saved each way', async ({ page, request }) => {
  const f = await open(page, request);
  // Typed: a click selects the cell, typing replaces what it holds, Enter puts it in and moves down.
  await deviceCell(f, 'RCP', 'name').click();
  await page.keyboard.type('Truck RCP %number%');
  await page.keyboard.press('Enter');
  await expect(box(f, 'Name for RCPs')).toHaveValue('Truck RCP %number%');
  await expect(deviceCell(f, 'RIO', 'name')).toHaveAttribute('data-hubble-spreadsheet-active', 'true');
  await expect.poll(async () => (await plan(request)).defaults.devices.RCP.name).toBe('Truck RCP %number%');
  await page.keyboard.press(UNDO);
  await expect(box(f, 'Name for RCPs')).toHaveValue('RCP %number%');
  await expect.poll(async () => (await plan(request)).defaults.devices.RCP.name).toBe('RCP %number%');
  await page.keyboard.press(REDO);
  await expect(box(f, 'Name for RCPs')).toHaveValue('Truck RCP %number%');

  // Delete clears a LAN IP pattern; Undo brings it back.
  await deviceCell(f, 'RIO', 'lan').click();
  await page.keyboard.press('Delete');
  await expect(box(f, 'LAN IP for RIOs')).toHaveValue('');
  await page.keyboard.press(UNDO);
  await expect(box(f, 'LAN IP for RIOs')).toHaveValue('10.20.101.1%number%');
  await expect.poll(async () => (await plan(request)).defaults.devices.RIO.lan).toBe('10.20.101.1%number%');

  // Escape while typing puts back what the cell held, and makes no step: Undo next takes back the name.
  await deviceCell(f, 'Gateway', 'mask').click();
  await page.keyboard.type('24');
  await page.keyboard.press('Escape');
  await expect(box(f, 'Mask for Gateways')).toHaveValue('16');
  await page.keyboard.press(UNDO);
  await expect(box(f, 'Mask for Gateways')).toHaveValue('16');
  await expect(box(f, 'Name for RCPs')).toHaveValue('RCP %number%');
  await page.keyboard.press(REDO);
  await expect(box(f, 'Name for RCPs')).toHaveValue('Truck RCP %number%');
});

test('adding and removing a camera model are steps of its table, and a removed model comes back in its place', async ({ page, request }) => {
  const f = await open(page, request);
  const add = tab(f).getByRole('button', { name: 'Add a camera model' });
  await add.click();
  await add.click();
  await expect(typeRows(f)).toHaveCount(2);
  // Give each a type by typing into its %type% cell.
  for (const [index, text] of ['FX', 'VEN'].entries()) {
    await typeRows(f).nth(index).locator('td[data-hubble-column="type"]').click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
  }
  await expect.poll(async () => (await plan(request)).cameraLogins.map((row: { type: string }) => row.type)).toEqual(['FX', 'VEN']);
  // Remove the first; Undo puts it back first, with its type.
  await typeRows(f).first().locator('[data-action="remove-camera-type"]').click();
  await expect(typeRows(f)).toHaveCount(1);
  await typeRows(f).first().locator('td[data-hubble-column="type"]').click();
  await page.keyboard.press(UNDO);
  await expect(typeRows(f)).toHaveCount(2);
  await expect.poll(async () => (await plan(request)).cameraLogins.map((row: { type: string }) => row.type)).toEqual(['FX', 'VEN']);
  await page.keyboard.press(REDO);
  await expect(typeRows(f)).toHaveCount(1);
  await page.keyboard.press(UNDO);
  // Then the typing, then the two rows added.
  await page.keyboard.press(UNDO);
  await page.keyboard.press(UNDO);
  await expect.poll(async () => (await plan(request)).cameraLogins.map((row: { type?: string }) => row.type ?? '')).toEqual(['', '']);
  await page.keyboard.press(UNDO);
  await page.keyboard.press(UNDO);
  await expect(typeRows(f)).toHaveCount(0);
  await expect.poll(async () => (await plan(request)).cameraLogins ?? []).toEqual([]);
});
