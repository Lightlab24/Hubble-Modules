import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
const frame = (page: Page) => page.frameLocator('iframe');
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const read = async (request: APIRequestContext) => (await (await request.post('/__rpc', { data: { commandId: 'read-plan' } })).json()).result;
const saved = async (request: APIRequestContext) => (await read(request)).plan;
const sheetsSaved = async (request: APIRequestContext) => (await saved(request))?.uiState?.privateContent?.cameraSheetsByDevice?.rcp1;
const simulate = (request: APIRequestContext, data: Record<string, unknown>) => request.post('/__simulate', { data });

async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: true } });
  await page.goto('/');
  const f = frame(page);
  await expect(f.locator('#cyanview-design')).toBeVisible();
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const group = f.locator('[data-controller="rcp1"]');
  await expect(group.getByRole('button', { name: 'Choose visible columns' })).toBeVisible();
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);
  return { f, group, sheet: group.getByRole('grid'), tab: (name: string) => group.getByRole('tab', { name, exact: false }) };
}
async function hide(page: Page, group: Locator, query: string, label: string) {
  await group.getByRole('button', { name: 'Choose visible columns' }).click();
  const popup = frame(page).getByRole('menu');
  await popup.getByRole('searchbox', { name: 'Search columns' }).fill(query);
  await popup.getByRole('menuitemcheckbox', { name: label, exact: true }).click();
  await popup.getByRole('searchbox').press('Escape');
}
const flip = (group: Locator) => group.getByRole('button', { name: 'Cameras in columns' }).click();
const unflip = (group: Locator) => group.getByRole('button', { name: 'Cameras in rows' }).click();
const flipped = (group: Locator, setting: string, camera: string) => group.locator(`td[data-hubble-row="${setting}"][data-hubble-column="${camera}"]`);
async function typeInto(cell: Locator, value: string) {
  await cell.dblclick();
  await cell.locator('input').fill(value);
  await cell.locator('input').press('Enter');
}
async function dragFillTo(page: Page, f: ReturnType<typeof frame>, destination: Locator) {
  const handle = f.locator('.hubble-spreadsheet-fill-handle:visible');
  await expect(handle).toBeVisible();
  const from = (await handle.boundingBox())!, to = (await destination.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('there is no tab strip; a plan saved with tabs opens on the one it showed and keeps the others', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { group } = await open(page, request);
  await expect(group.getByRole('tab')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Add sheet' })).toHaveCount(0);
  await expect(group.locator('.hc-sheet-tabs, [data-camera-sheets]')).toHaveCount(0);
  // A plan saved by an earlier version, showing its second tab with Password hidden and cameras in columns.
  const previous = await read(request), plan = previous.plan, data = plan.uiState.privateContent;
  data.cameraSheetsByDevice.rcp1 = { activeSheetId: 'network', sheets: [{ id: 'settings', name: 'Settings', view: 'rows', hidden: [], expanded: { iris: false, zoom: false, focus: false } }, { id: 'network', name: 'Network', view: 'columns' }] };
  data.hiddenCameraColumnsByDevice.rcp1 = ['password'];
  await request.post('/__rpc', { data: { commandId: 'save-plan', value: { revision: previous.revision, plan } } });
  await page.reload();
  const again = frame(page).locator('[data-controller="rcp1"]');
  await expect(again.locator('tr[data-setting="login"]')).toHaveCount(1);
  await expect(again.locator('tr[data-setting="password"]')).toHaveCount(0);
  await expect(again.getByRole('tab')).toHaveCount(0);
  // Changing the view changes the sheet it showed, and the other saved tab stays as it was.
  await unflip(again);
  await expect(again.locator('tr[data-id]')).toHaveCount(4);
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);
  const sheets = (await sheetsSaved(request)).sheets;
  expect(sheets.map((sheet: any) => [sheet.name, sheet.view])).toEqual([['Settings', 'rows'], ['Network', 'rows']]);
  expect((await sheetsSaved(request)).activeSheetId).toBe('network');
  expect((await inspect(request)).actions).toEqual([]);
  expect(errors).toEqual([]);
});
test('cameras in columns edit, fill, paste and report the same settings as cameras in rows', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { f, group, sheet } = await open(page, request);
  const name = group.locator('[data-hubble-row="cam2"][data-hubble-column="name"]');
  await name.click();
  await flip(group);
  await expect(group.getByRole('button', { name: 'Cameras in columns' })).toBeFocused();
  await expect(group.locator('th[data-camera-header]')).toHaveText([/1.*tight/, /2.*wide/, /3.*handheld/, /4.*reverse/]);
  await expect(group.locator('tr[data-id]')).toHaveCount(0);
  await expect(flipped(group, 'name', 'cam2')).toHaveAttribute('data-hubble-spreadsheet-active', 'true');
  await expect(group.locator('[data-camera-location]')).toHaveText('Camera 2 · Camera name');

  await sheet.press('ArrowRight');
  await expect(flipped(group, 'name', 'cam3')).toHaveAttribute('data-hubble-spreadsheet-active', 'true');

  await typeInto(flipped(group, 'name', 'cam1'), 'Shot 1');
  await expect(group.locator('th[data-camera-header="cam1"]')).toContainText('Shot 1');
  await expect(flipped(group, 'name', 'cam1')).toHaveClass(/hc-changed/);
  await typeInto(flipped(group, 'name', 'cam2'), 'Shot 2');

  await flipped(group, 'name', 'cam1').click();
  await sheet.press('Shift+ArrowRight');
  await dragFillTo(page, f, flipped(group, 'name', 'cam8'));
  await expect(flipped(group, 'name', 'cam3').locator('input')).toHaveValue('Shot 3');
  await expect(flipped(group, 'name', 'cam8').locator('input')).toHaveValue('Shot 4');

  await typeInto(flipped(group, 'port', 'cam1'), '8080');
  await flipped(group, 'port', 'cam1').click();
  await dragFillTo(page, f, flipped(group, 'port', 'cam8'));
  await expect(flipped(group, 'port', 'cam8').locator('input')).toHaveValue('8080');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await flipped(group, 'login', 'cam1').click();
  await page.evaluate(() => navigator.clipboard.writeText('alice\tbob'));
  await page.keyboard.press('Meta+v');
  await expect(flipped(group, 'login', 'cam1').locator('input')).toHaveValue('alice');
  await expect(flipped(group, 'login', 'cam2').locator('input')).toHaveValue('bob');
  await sheet.press('Meta+z');
  await expect(flipped(group, 'login', 'cam2').locator('input')).toHaveValue('admin');
  await sheet.press('Meta+Shift+z');
  await expect(flipped(group, 'login', 'cam2').locator('input')).toHaveValue('bob');

  await flipped(group, 'model', 'cam3').click();
  await sheet.press('Enter');
  await f.getByRole('dialog', { name: 'Select Camera model' }).getByRole('option', { name: 'Sony FR7', exact: true }).click();
  await expect(flipped(group, 'model', 'cam3').locator('[data-field="model"]')).toHaveAttribute('value', 'Sony FR7');

  await flipped(group, 'controlEnabled', 'cam2').getByRole('checkbox').check();
  await expect(group.locator('[data-control-count="rcp1"]')).toContainText('1 enabled');

  await expect.poll(async () => (await saved(request))?.cameras?.filter((row: any) => row.device === 'rcp1').map((row: any) => row.name)).toEqual(['Shot 1', 'Shot 2', 'Shot 3', 'Shot 4'].map((_, index) => ['Shot 1', 'Shot 2', 'Shot 3', 'Shot 4'][index]));
  await unflip(group);
  await expect(group.locator('[data-hubble-row="cam8"][data-hubble-column="name"] input')).toHaveValue('Shot 4');
  await expect(group.locator('[data-hubble-row="cam2"][data-hubble-column="login"] input')).toHaveValue('bob');
  expect((await inspect(request)).actions).toEqual([]);
  expect(errors).toEqual([]);
});

test('cameras in columns keep lens setup, sorting, sizes and camera deletion', async ({ page, request }) => {
  const { f, group, sheet } = await open(page, request);
  await flip(group);

  await flipped(group, 'lens', 'cam1').click();
  await sheet.press('Enter');
  await f.getByRole('dialog', { name: 'Select Lens model' }).getByRole('option', { name: 'ARRI - cforce', exact: true }).click();
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await expect(group.locator('tr[data-setting="irisTorque"]')).toHaveCount(1);
  const setup = flipped(group, 'irisSummary', 'cam1').getByRole('checkbox');
  await setup.check();
  await expect(setup).toBeChecked();
  await expect(flipped(group, 'irisTorque', 'cam1')).not.toHaveClass(/hc-axis-inactive/);
  await expect(flipped(group, 'irisTorque', 'cam2')).toHaveClass(/hc-axis-inactive/);

  await group.getByRole('button', { name: 'Sort by Camera number' }).click();
  await group.getByRole('button', { name: 'Sort by Camera number' }).click();
  await expect(group.locator('th[data-camera-header]').first()).toContainText('Venice 2 — tight');
  await group.getByRole('button', { name: 'Sort by Camera number' }).click();
  await expect(group.locator('th[data-camera-header]').first()).toContainText('Venice 2 — reverse');
  await group.getByRole('button', { name: 'Sort by Camera number' }).click();

  await f.getByRole('separator', { name: 'Resize camera 1', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.cameraLayouts?.rcp1?.cameraWidths?.cam1).toBeGreaterThan(168);
  await f.getByRole('separator', { name: 'Resize Port row', exact: true }).press('ArrowDown');
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.cameraLayouts?.rcp1?.settingHeights?.port).toBeGreaterThan(30);
  const width = await group.locator('th[data-camera-header="cam1"]').evaluate(element => (element as HTMLElement).offsetWidth);
  await page.reload();
  const again = frame(page).locator('[data-controller="rcp1"]');
  await expect(again.locator('th[data-camera-header="cam1"]')).toHaveCount(1);
  expect(await again.locator('th[data-camera-header="cam1"]').evaluate(element => (element as HTMLElement).offsetWidth)).toBe(width);

  await again.locator('th[data-camera-header="cam3"]').click({ button: 'right' });
  await frame(page).getByRole('menuitem', { name: 'Delete camera' }).click();
  // Pending sends doesn't open by itself any more; its button counts the delete.
  await expect(frame(page).locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]')).toHaveText(/\d+\s*pending/);
  await frame(page).locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  const staged = frame(page).locator('[data-pending-line="delete"]');
  await expect(staged).toContainText('Deleted from');
  await staged.getByRole('button').click();
  await expect(staged).toHaveCount(0);
  expect((await inspect(request)).actions).toEqual([]);
});

test('recording and status updates reach cameras in columns', async ({ page, request }) => {
  const { group } = await open(page, request);
  await flip(group);
  await expect(flipped(group, 'control', 'cam1')).toContainText('Online');
  await expect(flipped(group, 'recording', 'cam1')).toHaveText('—');
  expect(await flipped(group, 'sync', 'cam2').textContent()).toBe('Pending');
});

test('a plan from before tabs opens with its layout and no tab strip, and saving nothing changes nothing', async ({ page, request }) => {
  const { group } = await open(page, request);
  const previous = await read(request), plan = previous.plan;
  delete plan.uiState.privateContent.cameraSheetsByDevice;
  plan.uiState.privateContent.hiddenCameraColumnsByDevice.rcp1 = ['password'];
  await request.post('/__rpc', { data: { commandId: 'save-plan', value: { revision: previous.revision, plan } } });
  const saves = (await inspect(request)).planSaves;
  await page.reload();
  const again = frame(page).locator('[data-controller="rcp1"]');
  await expect(again.getByRole('tab')).toHaveCount(0);
  await expect(again.locator('tr[data-id]')).toHaveCount(4);
  await expect(again.locator('[data-column="password"]')).toHaveCount(0);
  expect((await inspect(request)).planSaves).toBe(saves);
  await expect(group).toHaveCount(1);
});
