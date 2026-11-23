import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
// Column sections in the Columns dropdown (a Hubble with module-spreadsheet-column-sections-v1, such as
// CYANVIEW_RENDERER_ASSETS from Hubble 2.3.1-beta.2 + the Columns dropdown redo). Older Hubbles skip.
const frame = (page: Page) => page.frameLocator('iframe');
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const saved = async (request: APIRequestContext) => (await (await request.post('/__rpc', { data: { commandId: 'read-plan' } })).json()).result.plan;
const privateContent = async (request: APIRequestContext) => (await saved(request))?.uiState?.privateContent;
async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: true } });
  await page.goto('/'); const f = frame(page);
  await expect(f.locator('#cyanview-design')).toBeVisible();
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const group = f.locator('[data-controller="rcp1"]');
  await expect(group.getByRole('button', { name: 'Choose visible columns' })).toBeVisible();
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);
  return { f, group, sheet: group.getByRole('grid') };
}
async function columns(page: Page, group: Locator) {
  await group.getByRole('button', { name: 'Choose visible columns' }).click();
  const menu = frame(page).getByRole('menu');
  await expect(menu).toBeVisible();
  test.skip(await menu.locator('.workbook-column-keep').count() === 0, 'This Hubble has no column sections');
  return menu;
}
const show = (menu: Locator, id: string) => menu.locator(`[data-column-choice="${id}"]`);
const keep = (menu: Locator, id: string) => menu.locator(`[data-column-keep="${id}"]`);
const status = (menu: Locator, id: string) => menu.locator(`.workbook-column-row:has([data-column-choice="${id}"]) > .workbook-column-status`);
const sectionRow = (menu: Locator, id: string) => menu.locator(`.workbook-column-group-row:has([data-column-choice="section:${id}"])`);
const drawn = (group: Locator) => group.locator('th[data-field-header]').evaluateAll(cells => cells.map(cell => (cell as HTMLElement).dataset.fieldHeader));
const irisDrawn = async (group: Locator) => (await drawn(group)).filter(id => id!.startsWith('iris'));

test('Show is each setting’s own tick and When collapsed picks what collapsed Iris keeps', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { group, sheet } = await open(page, request);
  const menu = await columns(page, group);
  // Collapsed Iris keeps nothing: every Iris setting is Collapsed and the page has the + band.
  await expect(sectionRow(menu, 'iris').locator('.workbook-column-expand')).toHaveText('Collapsed');
  await expect(status(menu, 'irisMax')).toHaveText('Collapsed');
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  expect(await irisDrawn(group)).toEqual([]);

  // When collapsed on Closed: it joins the collapsed band and stays Show-ticked.
  const saves = (await inspect(request)).planSaves;
  await keep(menu, 'irisMax').click();
  await expect(status(menu, 'irisMax')).toHaveText('Showing');
  await expect.poll(() => irisDrawn(group)).toEqual(['irisMax']);
  await expect.poll(async () => (await privateContent(request))?.cameraLayouts?.rcp1?.groups?.iris?.collapsed).toEqual(['irisMax']);
  expect((await inspect(request)).planSaves).toBe(saves + 1);

  // Untick Show on Open while Iris is collapsed; expanding never brings it back.
  await show(menu, 'irisMin').click();
  await expect(status(menu, 'irisMin')).toHaveText('Hidden');
  await expect(keep(menu, 'irisMin')).toBeDisabled();
  await sectionRow(menu, 'iris').locator('.workbook-column-expand').click();
  await expect(sectionRow(menu, 'iris').locator('.workbook-column-expand')).toHaveText('Expanded');
  await expect.poll(() => irisDrawn(group)).toEqual(['irisSummary', 'irisMotor', 'irisMax', 'irisTorque', 'irisDirection']);
  await expect(status(menu, 'irisMin')).toHaveText('Hidden');
  await expect(show(menu, 'irisMin')).not.toBeChecked();
  await expect(status(menu, 'irisMotor')).toHaveText('Showing');
  await page.screenshot({ path: 'artifacts/cyanview-column-sections-iris-expanded.png' });

  // A kept setting whose Show is unticked stays off, collapsed or not.
  await show(menu, 'irisMax').click();
  await sectionRow(menu, 'iris').locator('.workbook-column-expand').click();
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  expect(await irisDrawn(group)).toEqual([]);
  await expect(keep(menu, 'irisMax')).toBeChecked();
  await expect(status(menu, 'irisMax')).toHaveText('Hidden');
  const layout = (await privateContent(request)).cameraLayouts.rcp1;
  expect(layout.groups.iris.collapsed).toEqual(['irisMax']);
  expect((await privateContent(request)).hiddenCameraColumnsByDevice.rcp1).toEqual(expect.arrayContaining(['irisMin', 'irisMax']));

  // The band's + agrees with the dropdown's word, and Undo walks the changes back.
  await page.keyboard.press('Escape');
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await expect.poll(() => irisDrawn(group)).toEqual(['irisSummary', 'irisMotor', 'irisTorque', 'irisDirection']);
  await sheet.focus(); await sheet.press('Meta+z');
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  await sheet.press('Meta+z');
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toHaveCount(0);
  await expect.poll(() => irisDrawn(group)).toEqual(['irisSummary', 'irisMotor', 'irisTorque', 'irisDirection']);
  await sheet.press('Meta+z');
  await expect.poll(() => irisDrawn(group)).toEqual(['irisSummary', 'irisMotor', 'irisMax', 'irisTorque', 'irisDirection']);
  expect((await inspect(request)).actions).toEqual([]); expect(errors).toEqual([]);
});

test('a section with every setting unticked is switched off; ticking one brings it back with only that one', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { group } = await open(page, request);
  const menu = await columns(page, group);
  await sectionRow(menu, 'iris').locator('.workbook-column-expand').click();
  await expect.poll(async () => (await irisDrawn(group)).length).toBe(6);

  // The tick-all takes every Iris setting off at once: the section is switched off.
  await show(menu, 'section:iris').click();
  await expect(sectionRow(menu, 'iris').locator('.workbook-column-status[data-status="hidden"]')).toHaveText('Hidden');
  await expect.poll(() => irisDrawn(group)).toEqual([]);
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toHaveCount(0);
  await expect(group.locator('[data-axis-header="iris"]')).toHaveCount(0);
  await expect.poll(async () => (await privateContent(request))?.cameraLayouts?.rcp1?.hiddenGroups).toEqual(['iris']);

  // Ticking Closed brings Iris back with Closed alone.
  await show(menu, 'irisMax').click();
  await expect.poll(() => irisDrawn(group)).toEqual(['irisMax']);
  await expect(show(menu, 'irisMax')).toBeChecked();
  await expect(show(menu, 'irisMotor')).not.toBeChecked();
  await expect.poll(async () => (await privateContent(request))?.cameraLayouts?.rcp1?.hiddenGroups).toEqual([]);

  // Lens can't collapse: its own tick switches it off and back on with every setting.
  await expect(sectionRow(menu, 'lens').locator('.workbook-column-expand')).toHaveCount(0);
  await expect(keep(menu, 'lens')).toHaveCount(0);
  await show(menu, 'connection').click();
  await expect.poll(async () => (await drawn(group)).includes('connection')).toBe(false);
  await show(menu, 'lens').click();
  await expect(show(menu, 'section:lens')).not.toBeChecked();
  await expect.poll(async () => (await drawn(group)).includes('lens')).toBe(false);
  await show(menu, 'section:lens').click();
  await expect.poll(async () => (await drawn(group)).filter(id => id === 'lens' || id === 'connection')).toEqual(['lens', 'connection']);

  // It all survives a reload.
  await page.keyboard.press('Escape');
  await page.reload();
  await expect.poll(() => irisDrawn(group)).toEqual(['irisMax']);
  expect((await inspect(request)).actions).toEqual([]); expect(errors).toEqual([]);
});

test('Camera Configuration and the REMI Matrix list their own sections', async ({ page, request }) => {
  const { f } = await open(page, request);
  await f.locator('[data-tab="setup"]').click();
  const setup = f.locator('.hc-panel:not([hidden])').getByRole('button', { name: 'Choose visible columns' }).first();
  await setup.click();
  let menu = f.getByRole('menu');
  test.skip(await menu.locator('.workbook-column-keep').count() === 0, 'This Hubble has no column sections');
  await expect(menu.locator('[data-column-choice^="section:"]')).toHaveCount(6);
  await expect(menu.locator('[data-column-choice="section:source"]')).toBeVisible();
  await expect(menu.locator('.workbook-column-expand')).toHaveCount(3);
  await page.screenshot({ path: 'artifacts/cyanview-column-sections-camera-configuration.png' });
  await page.keyboard.press('Escape');
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await f.locator('.hc-panel:not([hidden])').getByRole('button', { name: 'Choose visible columns' }).first().click();
  menu = f.getByRole('menu');
  await expect(menu.locator('[data-column-choice^="section:"]')).toHaveCount(3);
  await expect(menu.locator('.workbook-column-expand')).toHaveCount(0);
});
