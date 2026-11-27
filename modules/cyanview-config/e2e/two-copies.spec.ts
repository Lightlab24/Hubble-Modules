import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// The page open in two places at once, both on one running module: two HubDash windows, or HubDash on two computers
// (Nov 25, 2026). Each copy used to hold the plan it read when it opened and save its whole plan back, so the second
// one silently undid the first one's edits, and a tab click in one saved the plan and pulled the other along.
const frame = (page: Page) => page.frameLocator('iframe');
const rpc = async (request: APIRequestContext, commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json());
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const saved = async (request: APIRequestContext) => (await rpc(request, 'read-plan')).result.plan;
const savedName = async (request: APIRequestContext, id: string) => (await saved(request))?.cameras.find((camera: { id: string }) => camera.id === id)?.name;
const settled = async (request: APIRequestContext) => expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);
const toast = (f: FrameLocator) => f.locator('[data-role="toast"]');
const group = (f: FrameLocator, id: string) => f.locator('[data-controller="' + id + '"]');
const cell = (f: FrameLocator, row: string, column = 'name') => group(f, 'rcp1').locator('[data-hubble-row="' + row + '"][data-hubble-column="' + column + '"]');

async function open(page: Page) {
  await page.goto('/');
  const f = frame(page);
  await expect(f.locator('#cyanview-design')).toBeVisible();
  return f;
}
/** Camera Configuration by controller, as the operator opens it. */
async function controllers(f: FrameLocator) {
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click();
  await expect(group(f, 'rcp1').getByRole('button', { name: 'Choose visible columns' })).toBeVisible();
}
/** Types into a camera's name with real key presses and leaves the cell open. */
async function typeName(page: Page, f: FrameLocator, row: string, text: string) {
  const target = cell(f, row);
  await target.dblclick();
  const editor = target.locator('input');
  await expect(editor).toHaveClass(/hc-cell-editing/);
  await editor.fill('');
  await page.keyboard.type(text);
  return editor;
}
async function rename(page: Page, f: FrameLocator, row: string, text: string) {
  const editor = await typeName(page, f, row, text);
  await editor.press('Enter');
}
/** A workspace that has been saved once, then a second copy of the page opened on it. */
async function twoCopies(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: true } });
  const one = await open(page);
  await controllers(one);
  await rename(page, one, 'cam2', 'Shot 2');
  await expect.poll(() => savedName(request, 'cam2')).toBe('Shot 2');
  await settled(request);
  const second = await page.context().newPage();
  const two = await open(second);
  await controllers(two);
  await expect(cell(two, 'cam2').locator('input')).toHaveValue('Shot 2');
  return { one, second, two };
}

test('an edit saved in one copy shows in the other without a reload, and each copy keeps its own place', async ({ page, request }) => {
  const { one, second, two } = await twoCopies(page, request);
  await settled(request);
  const before = (await inspect(request)).planSaves;
  // Where the second copy is: a sort, another controller open, and the Pending sends panel.
  await group(two, 'rcp1').locator('[data-sort-field="name"]').click();
  await expect(group(two, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'ascending');
  await group(two, 'rcp2').locator('[data-action="toggle-controller"]').click();
  await expect(group(two, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'true');
  // A view change writes nothing to the shared plan, and doesn't move the first copy.
  await page.waitForTimeout(600);
  expect((await inspect(request)).planSaves, 'no plan save for a sort or an expand').toBe(before);
  await expect(group(one, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'none');
  await expect(group(one, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'false');

  // An edit in the first copy shows in the second, which stays where it was.
  await rename(page, one, 'cam3', 'Shot 3');
  await expect.poll(() => savedName(request, 'cam3')).toBe('Shot 3');
  await expect(cell(two, 'cam3').locator('input')).toHaveValue('Shot 3');
  await expect(group(two, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'ascending');
  await expect(group(two, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'true');
  await expect(two.locator('#hc-tab-assignment')).toHaveAttribute('aria-selected', 'true');

  // And back the other way. Neither save is refused and neither undoes the other's rows.
  await rename(second, two, 'cam1', 'Shot 1');
  await expect.poll(() => savedName(request, 'cam1')).toBe('Shot 1');
  await expect(cell(one, 'cam1').locator('input')).toHaveValue('Shot 1');
  const plan = await saved(request);
  expect(['cam1', 'cam2', 'cam3'].map(id => plan.cameras.find((camera: { id: string }) => camera.id === id).name)).toEqual(['Shot 1', 'Shot 2', 'Shot 3']);
  for (const f of [one, two]) {
    await expect(f.locator('[data-role="saved-label"]')).not.toContainText('not saved');
    await expect(toast(f)).not.toContainText('another');
  }
  // A tab change in one copy leaves the other where it is.
  await one.locator('[data-tab="devices"]').click();
  await expect(one.locator('#hc-devices')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(two.locator('#hc-devices')).toBeHidden();
  await expect(group(two, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'ascending');
  expect((await inspect(request)).planSaves - before, 'only the two renames saved the plan').toBe(2);
});

test('a cell being typed in is never cleared by the other copy’s save, and both edits are kept', async ({ page, request }) => {
  const { one, second, two } = await twoCopies(page, request);
  const editor = await typeName(second, two, 'cam3', 'Typed in two');
  await rename(page, one, 'cam1', 'From one');
  await expect.poll(() => savedName(request, 'cam1')).toBe('From one');
  // Several of the second copy's follow checks go by while it is typing.
  await second.waitForTimeout(1200);
  await expect(editor).toHaveValue('Typed in two');
  await expect(editor).toHaveClass(/hc-cell-editing/);
  await expect(editor).toBeFocused();
  await second.keyboard.type(' more');
  await editor.press('Enter');
  await expect.poll(() => savedName(request, 'cam3')).toBe('Typed in two more');
  expect(await savedName(request, 'cam1'), 'the other copy’s edit is not undone').toBe('From one');
  await expect(cell(two, 'cam1').locator('input')).toHaveValue('From one');
  await expect(cell(one, 'cam3').locator('input')).toHaveValue('Typed in two more');
  await expect(toast(two)).not.toContainText('another');
  await expect(two.locator('[data-role="saved-label"]')).not.toContainText('not saved');
});

test('the same cell typed in both copies keeps what was typed last and says so', async ({ page, request }) => {
  const { one, second, two } = await twoCopies(page, request);
  const editor = await typeName(second, two, 'cam2', 'From two');
  await rename(page, one, 'cam2', 'From one');
  await expect.poll(() => savedName(request, 'cam2')).toBe('From one');
  await editor.press('Enter');
  await expect.poll(() => savedName(request, 'cam2')).toBe('From two');
  await expect(toast(two)).toContainText('also changed in another window. What you typed is kept.');
  await expect(cell(one, 'cam2').locator('input')).toHaveValue('From two');
  // The next edit in either copy saves normally.
  await rename(page, one, 'cam3', 'Shot 3');
  await expect.poll(() => savedName(request, 'cam3')).toBe('Shot 3');
  await expect(cell(two, 'cam3').locator('input')).toHaveValue('Shot 3');
  await expect(one.locator('[data-role="saved-label"]')).not.toContainText('not saved');
});

test('a reopened page comes back where it was left, and the plan holds no tab, sort or open controllers', async ({ page, request }) => {
  const { second, two } = await twoCopies(page, request);
  await group(two, 'rcp1').locator('[data-sort-field="name"]').click();
  await group(two, 'rcp2').locator('[data-action="toggle-controller"]').click();
  await expect(group(two, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await rpc(request, 'page-view')).result.view?.cameraSortByDevice?.rcp1?.field).toBe('name');
  const content = (await saved(request)).uiState.privateContent;
  for (const key of ['tab', 'openControllers', 'cameraSortByDevice', 'deviceFilter']) expect(content, key).not.toHaveProperty(key);
  expect(content.remiView).not.toHaveProperty('byController');
  await second.reload();
  const again = frame(second);
  await expect(again.locator('#cyanview-design')).toBeVisible();
  await expect(again.locator('#hc-tab-assignment')).toHaveAttribute('aria-selected', 'true');
  await expect(group(again, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'ascending');
  await expect(group(again, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'true');
});

test('a device name being typed in one copy survives the other copy renaming another device', async ({ page, request }) => {
  const MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
  const name = (f: FrameLocator, id: string) => f.locator('[data-role="device-sheet"] [data-device-cell="' + id + ':name"]');
  const savedDevice = async (id: string) => (await saved(request)).devices.find((device: { id: string }) => device.id === id)?.name;
  await request.post('/__reset', { data: { sample: false, remi: true } });
  const one = await open(page);
  await expect(one.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const second = await page.context().newPage();
  const two = await open(second);
  await expect(name(two, LEAF)).toBeVisible();
  await settled(request);
  // The second copy is part way through a name.
  await name(two, LEAF).click();
  await second.keyboard.press('ControlOrMeta+A');
  await second.keyboard.type('Typed in two');
  // The first copy renames another device.
  await name(one, MASTER).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Master renamed');
  await page.keyboard.press('Enter');
  await expect.poll(() => savedDevice(MASTER)).toBe('Master renamed');
  await second.waitForTimeout(1200);
  await expect(name(two, LEAF)).toHaveValue('Typed in two');
  await expect(name(two, LEAF)).toBeFocused();
  await second.keyboard.press('Enter');
  await expect.poll(() => savedDevice(LEAF)).toBe('Typed in two');
  expect(await savedDevice(MASTER), 'the first copy’s rename is not undone').toBe('Master renamed');
  await expect(name(two, MASTER)).toHaveValue('Master renamed');
  await expect(name(one, LEAF)).toHaveValue('Typed in two');
  for (const f of [one, two]) await expect(f.locator('[data-role="saved-label"]')).not.toContainText('not saved');
});

test('a merged save that lands while another cell is being typed in leaves that cell alone', async ({ page, request }) => {
  const { one, second, two } = await twoCopies(page, request);
  // The second copy is busy typing while the first saves, so its own save will be on an older plan.
  const first = await typeName(second, two, 'cam3', 'Shot 3');
  await rename(page, one, 'cam8', 'From one');
  await expect.poll(() => savedName(request, 'cam8')).toBe('From one');
  await settled(request);
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  try {
    await first.press('Enter');
    await expect.poll(async () => (await inspect(request)).planSavePending).toBe(1);
    // While that save is held, a new cell is opened and typed in.
    const editor = await typeName(second, two, 'cam1', 'Still typing');
    await request.post('/__simulate', { data: { releasePlanWrites: true } });
    await expect.poll(() => savedName(request, 'cam3')).toBe('Shot 3');
    await expect(cell(two, 'cam8').locator('input')).toHaveValue('From one');
    await expect(editor).toHaveValue('Still typing');
    await expect(editor).toHaveClass(/hc-cell-editing/);
    await expect(editor).toBeFocused();
    await editor.press('Enter');
    await expect.poll(() => savedName(request, 'cam1')).toBe('Still typing');
  } finally { await request.post('/__simulate', { data: { releasePlanWrites: true } }); }
  expect(await savedName(request, 'cam8'), 'the first copy’s edit is not undone').toBe('From one');
  await expect(cell(one, 'cam3').locator('input')).toHaveValue('Shot 3');
  await expect(cell(one, 'cam1').locator('input')).toHaveValue('Still typing');
});

test('a send from one copy is read back by one copy, and the others follow without reading or saving it', async ({ page, request }) => {
  // On Nov 27, 2026 six copies were open in the packaged app when one sent: each copy read the controller back after
  // every change it reported and saved what it read, and under that contention three gave up with "Configuration
  // changed in another editor". Now the worker has one copy read each change, and every copy waits for a send from
  // any copy to finish before reading.
  test.setTimeout(60000);
  await request.post('/__reset', { data: { sample: false, remi: true, live: true } });
  let counting = false;
  const counts: { saves: number; reads: number; stale: number }[] = [];
  const watch = (copy: Page) => {
    const count = { saves: 0, reads: 0, stale: 0 };
    counts.push(count);
    copy.on('requestfinished', async finished => {
      if (!counting || !finished.url().endsWith('/__rpc')) return;
      const body = finished.postDataJSON() ?? {}, reply = await (await finished.response())?.json().catch(() => ({})) ?? {};
      if (['save-plan', 'save-commit'].includes(body.commandId)) { count.saves++; if (String(reply.error ?? '').includes('another editor')) count.stale++; }
      if (body.commandId === 'refresh' && body.value?.live && reply.result?.snapshots?.length) count.reads++;
    });
  };
  const copies: FrameLocator[] = [];
  for (let index = 0; index < 4; index++) {
    const copy = index ? await page.context().newPage() : page;
    watch(copy);
    await copy.goto('/');
    const f = frame(copy);
    await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
    copies.push(f);
  }
  const sender = copies[0]!;
  await sender.locator('[data-tab="setup"]').click();
  const row = sender.locator('[data-controller="__camera-setup__"] tbody tr[data-id]').first(), id = await row.getAttribute('data-id');
  await row.locator('[data-column="name"] input').fill('Sent from one copy');
  await row.locator('[data-column="name"] input').press('Enter');
  await settled(request);
  counting = true;
  await sender.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await sender.locator('[data-role="pending-sends"] [data-action="send-all-pending"]').click();
  await expect(row.locator('[data-column="sync"]')).toHaveText(/Verified|In sync/, { timeout: 15000 });
  // Every copy shows it, from the plan.
  for (const f of copies.slice(1)) {
    await f.locator('[data-tab="setup"]').click();
    await expect(f.locator(`[data-controller="__camera-setup__"] tbody tr[data-id="${id}"] [data-column="name"] input`)).toHaveValue('Sent from one copy');
  }
  await page.waitForTimeout(3000);
  await settled(request);
  const reads = counts.reduce((sum, count) => sum + count.reads, 0), followerSaves = counts.slice(1).reduce((sum, count) => sum + count.saves, 0);
  expect(reads, 'controller read back by one copy, ' + JSON.stringify(counts)).toBeLessThanOrEqual(2);
  expect(followerSaves, 'the other copies save at most what one of them read, ' + JSON.stringify(counts)).toBeLessThanOrEqual(1);
  expect(counts.every(count => count.stale === 0), 'no save refused').toBe(true);
  for (const f of copies) await expect(toast(f)).not.toContainText('another editor');
});
