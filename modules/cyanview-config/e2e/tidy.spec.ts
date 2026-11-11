import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

// The tidied page: a camera count instead of Add camera, no sheet tabs, Hubble's own lists instead
// of system menus, Add and Add all for found devices, Clear all on each controller, a small Pending
// sends that never opens by itself, and ⌘+ / ⌘− for the sheets' text size.
const ui = (page: Page) => page.frameLocator('iframe');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const setupRows = (f: FrameLocator) => setup(f).locator('tbody tr[data-id]');
const count = (f: FrameLocator, id = '__camera-setup__') => f.locator('[data-camera-count="' + id + '"]');
const pendingButton = (f: FrameLocator) => f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]');
const quickSend = (f: FrameLocator) => f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="send-all-pending-quick"]');
const deviceRow = (f: FrameLocator, id: string) => f.locator('[data-role="device-sheet"] tr[data-device-row="' + id + '"]');
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as { config: { Camera: Record<string, { Name: string }> }; actions: unknown[] }[];
const names = (rows: Locator) => rows.locator('input[data-field="name"]').evaluateAll(list => list.map(input => (input as HTMLInputElement).value));

async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}) {
  await request.post('/__reset', { data: { sample: false, remi: true, ...data } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return f;
}
async function showSetup(f: FrameLocator) {
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
}

test('the camera count adds rows at the end and takes them off the end, and nothing is sent', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await showSetup(f);
  const before = (await fleet(request)).map(device => device.actions.length);
  await expect(count(f).locator('input')).toHaveValue('2');
  await count(f).getByRole('button', { name: 'One camera more' }).click();
  await count(f).getByRole('button', { name: 'One camera more' }).click();
  await expect(count(f).locator('input')).toHaveValue('4');
  await expect(setupRows(f)).toHaveCount(4);
  // Numbered on from the highest camera, with the model of the last one.
  expect(await names(setupRows(f))).toEqual(['Wide', 'Jib', 'Camera 8', 'Camera 9']);
  await expect(setupRows(f).nth(3).locator('[data-column="model"]')).toContainText('Venice-IP');
  // Typing a lower number drops the unsent rows first, then marks the highest camera for delete.
  await count(f).locator('input').fill('1');
  await count(f).locator('input').press('Enter');
  await expect(setupRows(f)).toHaveCount(2);
  await expect(setup(f).locator('tbody tr.hc-remove-staged')).toHaveCount(1);
  await expect(setup(f).locator('tbody tr.hc-remove-staged input[data-field="name"]')).toHaveValue('Jib');
  await expect(count(f).locator('input')).toHaveValue('1');
  // Pending sends says so in its button and stays shut.
  await expect(pendingButton(f)).toHaveText(/1\s*pending/);
  await expect(quickSend(f)).toHaveText('Send 1');
  await expect(f.locator('[data-role="pending-sends"]')).toBeHidden();
  // Raising it again brings the marked camera back before making a new one.
  await count(f).getByRole('button', { name: 'One camera more' }).click();
  await expect(setup(f).locator('tbody tr.hc-remove-staged')).toHaveCount(0);
  await expect(setupRows(f)).toHaveCount(2);
  await expect(pendingButton(f)).toHaveText(/All sent/);
  await expect(quickSend(f)).toBeHidden();
  // A camera deleted with its own bin stays deleted; raising the count makes a new row instead.
  await setup(f).locator('tbody tr[data-id]:has(input[data-field="name"][value="Jib"]) [data-action="stage-remove"]').click();
  await expect(count(f).locator('input')).toHaveValue('1');
  await count(f).getByRole('button', { name: 'One camera more' }).click();
  await expect(setup(f).locator('tbody tr.hc-remove-staged input[data-field="name"]')).toHaveValue('Jib');
  expect(await names(setupRows(f))).toEqual(['Wide', 'Jib', 'Camera 8']);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
});

test('the camera count on a controller adds rows there, and Clear all cameras asks first', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click();
  const card = f.locator('[data-controller="' + MASTER + '"]');
  if (!await count(f, MASTER).isVisible()) await card.locator('[data-action="toggle-controller"]').click();
  await expect(count(f, MASTER).locator('input')).toHaveValue('1');
  await count(f, MASTER).getByRole('button', { name: 'One camera more' }).click();
  await expect(card.locator('tbody tr[data-id]')).toHaveCount(2);
  await expect(card.locator('tbody tr[data-id]').nth(1).locator('input[data-field="number"]')).toHaveValue('8');
  // No sheet tabs and no footer under a controller's sheet.
  await expect(card.locator('.hc-sheet-tabs, [data-camera-sheets], .hc-controller-bottom')).toHaveCount(0);
  await expect(card.getByRole('tab')).toHaveCount(0);
  await card.getByRole('button', { name: 'Clear all cameras' }).click();
  const dialog = f.getByRole('dialog', { name: 'Clear all cameras on Master RCP' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // The REMI panel opens from its own button now that there's no Add camera menu.
  await card.getByRole('button', { name: 'REMI cameras' }).click();
  await expect(card.locator('[data-remi-panel]')).toBeVisible();
});

test('lists open Hubble’s own pop-up, and a choice made with the keyboard reaches the page', async ({ page, request }) => {
  const f = await open(page, request);
  await f.locator('[data-tab="devices"]').click();
  const range = f.locator('[data-role="scan-bar"] button.hc-dropdown').first();
  await expect(range).toHaveText('Choose a network…');
  await expect(f.locator('[data-role="scan-range"]')).toHaveCSS('opacity', '0');
  await expect(f.locator('[data-role="scan-bar"] [data-action="scan"]')).toBeDisabled();
  await range.focus();
  await range.press('ArrowDown');
  const menu = f.locator('.hc-dropdown-menu[role="listbox"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option')).toHaveText(['Choose a network…', '10.192.0.0/16', '10.20.0.0/16', 'Custom range…']);
  await range.press('ArrowDown');
  await range.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(range).toHaveText('10.192.0.0/16');
  await expect(f.locator('[data-role="scan-range"]')).toHaveValue('10.192.0.0/16');
  await expect(f.locator('[data-role="scan-bar"] [data-action="scan"]')).toBeEnabled();
  // A click outside puts an open list away without choosing.
  await range.click();
  await expect(menu).toBeVisible();
  await f.locator('[data-role="device-sheet"] thead').click();
  await expect(menu).toHaveCount(0);
  await expect(range).toHaveText('10.192.0.0/16');
});

test('found devices list as rows with their own Add, and Add all takes every one', async ({ page, request }) => {
  const f = await open(page, request);
  await f.locator('[data-tab="devices"]').click();
  await deviceRow(f, RIO).getByRole('button', { name: /Remove Stage RIO/ }).click();
  await expect(f.locator('[data-role="device-sheet"] tr[data-device-row]')).toHaveCount(2);
  const range = f.locator('[data-role="scan-bar"] button.hc-dropdown').first();
  await range.click();
  await f.locator('.hc-dropdown-menu').getByRole('option', { name: '10.192.0.0/16' }).click();
  await f.locator('[data-role="scan-bar"] [data-action="scan"]').click();
  const found = f.locator('[data-role="device-sheet"] tr[data-device-found]');
  await expect(found).toHaveCount(1);
  await expect(found).toContainText(RIO);
  await expect(f.locator('[data-role="found-summary"]')).toHaveText('1 found');
  await expect(f.locator('[data-action="add-all-found"]')).toHaveText('Add all 1');
  // No ticks to pick from any more.
  await expect(f.locator('input[data-select-found]')).toHaveCount(0);
  await f.locator('[data-action="add-all-found"]').click();
  await expect(f.locator('[data-role="device-sheet"] tr[data-device-row]')).toHaveCount(3);
  await expect(found).toHaveCount(0);
  await expect(f.locator('[data-action="add-all-found"]')).toBeHidden();
  // Taken off again and added from its own row.
  await deviceRow(f, RIO).getByRole('button', { name: /Remove/ }).click();
  await f.locator('[data-role="scan-bar"] [data-action="scan"]').click();
  await expect(found).toHaveCount(1);
  await found.getByRole('button', { name: 'Add ' + RIO }).click();
  await expect(f.locator('[data-role="device-sheet"] tr[data-device-row]')).toHaveCount(3);
});

test('the remove button sits beside the name on Devices, as on the camera sheets', async ({ page, request }) => {
  const f = await open(page, request);
  await f.locator('[data-tab="devices"]').click();
  const cells = await deviceRow(f, MASTER).locator('td').evaluateAll(list => list.slice(0, 3).map(cell => (cell as HTMLElement).dataset.deviceColumn));
  expect(cells).toEqual(['row', 'name', 'remove']);
});

test('⌘+ and ⌘− change the text size on every sheet, ⌘0 puts it back, and it is kept', async ({ page, request }) => {
  const f = await open(page, request);
  await showSetup(f);
  await setup(f).locator('.hc-controller-tools').click({ position: { x: 600, y: 10 } });
  await page.keyboard.press('Meta+Equal');
  await page.keyboard.press('Meta+Equal');
  const size = (id: string) => f.locator('table[data-camera-device="' + id + '"]').evaluate(table => (table as HTMLElement).style.getPropertyValue('--hc-camera-text-size'));
  await expect.poll(() => size('__camera-setup__')).toBe('15px');
  await expect(f.locator('[data-role="toast"]')).toContainText('Text size 15');
  await f.locator('[data-tab="assignment"]').click();
  await expect.poll(() => size('__all-cameras__')).toBe('15px');
  await page.keyboard.press('Meta+Minus');
  await expect.poll(() => size('__all-cameras__')).toBe('14px');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await f.locator('[data-tab="assignment"]').click();
  await expect.poll(() => size('__all-cameras__')).toBe('14px');
  await page.keyboard.press('Meta+Digit0');
  await expect.poll(() => size('__all-cameras__')).toBe('13px');
});
