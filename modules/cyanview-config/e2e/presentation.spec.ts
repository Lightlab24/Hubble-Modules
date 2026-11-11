import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
const frame = (page: Page) => page.frameLocator('iframe');
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
async function read(request: APIRequestContext) { return (await (await request.post('/__rpc', { data: { commandId: 'read-plan' } })).json()).result; }
const saved = async (request: APIRequestContext) => (await read(request)).plan;
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
async function menu(page: Page, group: Locator, query: string) {
  await group.getByRole('button', { name: 'Choose visible columns' }).click();
  const popup = frame(page).getByRole('menu');
  await popup.getByRole('searchbox', { name: 'Search columns' }).fill(query);
  return popup;
}
async function paint(page: Page, popup: Locator, release = true) {
  const a = (await popup.getByRole('menuitemcheckbox', { name: 'Motor ID', exact: true }).boundingBox())!;
  const b = (await popup.getByRole('menuitemcheckbox', { name: 'Closed', exact: true }).boundingBox())!;
  await page.mouse.move(a.x + 14, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + 14, b.y + b.height / 2, { steps: 12 });
  await expect(popup.locator('[data-visibility-kind="field"][data-visibility-preview="true"]')).toHaveCount(3);
  if (release) await page.mouse.up();
}
async function edit(group: Locator, row: string, value: string) {
  const cell = group.locator(`[data-hubble-row="${row}"][data-hubble-column="name"]`);
  await cell.dblclick(); await cell.locator('input').fill(value); await cell.locator('input').press('Enter');
}
const textSize = (group: Locator) => group.getByRole('grid').evaluate(table => (table as HTMLElement).style.getPropertyValue('--hc-camera-text-size'));
const layout = async (request: APIRequestContext) => (await saved(request))?.uiState?.privateContent?.cameraLayouts?.rcp1;
test('shared Columns paints one save and history step, cancels, searches and keeps group preferences independent', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { f, group, sheet } = await open(page, request);
  await expect(group.locator('[data-column="irisSummary"]')).toHaveCount(0);
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  const popup = await menu(page, group, 'Iris');
  const baseline = (await inspect(request)).planSaves;
  await paint(page, popup, false);
  expect((await inspect(request)).planSaves).toBe(baseline);
  await expect(popup.getByRole('menuitemcheckbox', { name: 'Iris', exact: true })).toBeChecked();
  await page.mouse.up();
  await expect.poll(async () => (await layout(request))?.groups?.iris?.collapsed).toEqual(['irisMotor', 'irisMin', 'irisMax']);
  expect((await inspect(request)).planSaves).toBe(baseline + 1);
  await popup.getByRole('searchbox').press('Escape');
  await sheet.focus(); await sheet.press('Meta+z');
  await expect(group.locator('[data-column="irisMotor"]')).toHaveCount(0);
  await sheet.press('Meta+Shift+z'); await expect(group.locator('[data-column="irisMotor"]').first()).toBeVisible();
  const next = await menu(page, group, 'Iris');
  await next.getByRole('menuitemcheckbox', { name: 'Iris', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toHaveCount(0);
  await expect(next.getByRole('menuitemcheckbox', { name: 'Motor ID', exact: true })).toBeChecked();
  await next.getByRole('menuitemcheckbox', { name: 'Iris', exact: true }).click();
  await expect(group.locator('[data-column="irisMotor"]').first()).toBeVisible();
  await next.getByRole('searchbox').fill('No matching setting'); await expect(next.getByText('No matching columns')).toBeVisible();
  await next.getByRole('searchbox').fill('Zoom');
  const before = (await inspect(request)).planSaves;
  const a = (await next.getByRole('menuitemcheckbox', { name: 'Motor ID', exact: true }).boundingBox())!;
  const b = (await next.getByRole('menuitemcheckbox', { name: 'Direction', exact: true }).boundingBox())!;
  await page.mouse.move(a.x + 14, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + 14, b.y + b.height / 2, { steps: 10 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect((await inspect(request)).planSaves).toBe(before);
  await next.getByRole('searchbox').press('Escape');
  await page.screenshot({ path: 'artifacts/cyanview-columns-0.1.23.png' });
  expect((await inspect(request)).actions).toEqual([]); expect(errors).toEqual([]);
});

test('⌘+ and ⌘− size the text with an editor open and a save held, independently of sheet zoom', async ({ page, request }) => {
  const { group, sheet } = await open(page, request);
  const input = group.locator('[data-hubble-row="cam2"][data-hubble-column="name"] input');
  const nameWidth = await group.locator('th[data-field-header="name"]').evaluate(element => (element as HTMLElement).offsetWidth);
  const size = () => textSize(group);
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  await edit(group, 'cam1', 'First held edit');
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(1);
  await input.locator('..').dblclick(); await input.fill('Typing during a save');
  await page.keyboard.press('Meta+Equal');
  await expect.poll(size).toBe('14px'); await expect(input).toBeFocused();
  expect(await input.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px');
  expect(await group.locator('th[data-field-header="name"]').evaluate(element => (element as HTMLElement).offsetWidth)).toBe(nameWidth);
  const cellBox = (await input.locator('..').boundingBox())!, inputBox = (await input.boundingBox())!;
  for (const edge of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(cellBox[edge] - inputBox[edge])).toBeLessThanOrEqual(1);
  await request.post('/__simulate', { data: { releasePlanWrites: true } });
  await expect(input).toBeFocused(); await expect(input).toHaveValue('Typing during a save'); await input.press('Enter');
  await expect.poll(async () => (await saved(request))?.cameras?.find((row: any) => row.id === 'cam2')?.name).toBe('Typing during a save');
  // Text size isn't an edit, so Undo takes back the camera edit and leaves the size.
  await sheet.focus(); await sheet.press('Meta+z'); await expect(input).toHaveValue('Venice 2 — wide');
  await expect.poll(size).toBe('14px');
  await sheet.press('Meta+Shift+z'); await expect(input).toHaveValue('Typing during a save');
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await sheet.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('Meta+Equal');
  await expect.poll(size).toBe('24px');
  const heading = (await group.locator('th.hc-camera-group-header').first().boundingBox())!, child = (await group.locator('th[data-field-header="irisSummary"]').boundingBox())!;
  expect(Math.abs(heading.y + heading.height - child.y)).toBeLessThanOrEqual(1);
  const checkbox = (await group.locator('[data-hubble-row="cam1"] [role="checkbox"]').first().boundingBox())!;
  expect(checkbox.width).toBe(18); expect(checkbox.height).toBe(18);
  for (let i = 0; i < 15; i++) await page.keyboard.press('Meta+Minus');
  await expect.poll(size).toBe('10px');
  for (let i = 0; i < 7; i++) await page.keyboard.press('Meta+Equal');
  await expect.poll(size).toBe('18px');
  await expect.poll(async () => (await layout(request))?.textSize).toBe(18);
  await group.locator('.hc-scroll').evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 600, clientY: 400, cancelable: true, bubbles: true })));
  await expect(group.locator('[data-camera-zoom]')).toHaveText('120%'); await expect.poll(size).toBe('18px');
  await page.reload(); await expect.poll(size).toBe('18px'); await expect(group.locator('[data-camera-zoom]')).toHaveText('100%');
  expect((await inspect(request)).actions).toEqual([]);
});

test('a rejected paint rolls back dependent text sizing while an unrelated later camera edit saves', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { group } = await open(page, request);
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  const popup = await menu(page, group, 'Iris'); await paint(page, popup);
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(1);
  await popup.getByRole('searchbox').press('Escape');
  await group.getByRole('grid').focus(); await page.keyboard.press('Meta+Equal');
  await expect.poll(() => textSize(group)).toBe('14px');
  await edit(group, 'cam1', 'Independent retained draft');
  await request.post('/__simulate', { data: { failPlanWrite: true, releasePlanWrites: true } });
  await expect(group.locator('[data-column="irisMotor"]')).toHaveCount(0);
  await expect.poll(() => textSize(group)).toBe('13px');
  await expect.poll(async () => (await saved(request))?.cameras?.find((row: any) => row.id === 'cam1')?.name).toBe('Independent retained draft');
  expect((await layout(request)).groups.iris?.collapsed ?? []).toEqual([]);
  expect((await layout(request)).textSize).toBe(13);
  await expect(frame(page).locator('[data-role="toast"]')).toContainText('Simulated storage failure');
  expect((await inspect(request)).actions).toEqual([]); expect(errors).toEqual([]);
});

test('opening a legacy plan preserves explicit collapsed fields, staged settings and layout without a migration save', async ({ page, request }) => {
  const { group } = await open(page, request);
  const previous = await read(request), plan = previous.plan;
  const data = plan.uiState.privateContent;
  data.cameraLayouts.rcp1 = { columns: { name: 231 }, rows: { cam1: 58 }, groups: { iris: { order: ['irisTorque', 'irisSummary', 'irisMin'], collapsed: ['irisTorque'] } } };
  data.axisGroupsByDevice.rcp1 = { iris: false, zoom: false, focus: false };
  data.hiddenCameraColumnsByDevice.rcp1 = ['password'];
  plan.cameras.find((row: any) => row.id === 'cam1').name = 'Existing staged camera';
  plan.cameras.find((row: any) => row.id === 'cam1').dirty = ['name'];
  await request.post('/__rpc', { data: { commandId: 'save-plan', value: { revision: previous.revision, plan } } });
  const count = (await inspect(request)).planSaves;
  await page.reload();
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  await expect(group.locator('[data-column="irisTorque"]').first()).toBeVisible();
  await expect(group.locator('[data-column="irisSummary"]')).toHaveCount(0);
  await expect(group.locator('[data-column="password"]')).toHaveCount(0);
  await expect.poll(() => textSize(group)).toBe('13px');
  expect(await group.locator('th[data-field-header="name"]').evaluate(element => (element as HTMLElement).offsetWidth)).toBe(231);
  expect((await inspect(request)).planSaves).toBe(count);
  expect(await saved(request)).toEqual(plan);
  expect((await inspect(request)).actions).toEqual([]);
});
