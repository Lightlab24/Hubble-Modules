import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// The Devices sheet on Hubble's grid, with the undo Hubble keeps for it (module-spreadsheet-history-v1),
// driven with real clicks and keys against simulated controllers. It needs Hubble's shared controls with
// grid undo: point CYANVIEW_RENDERER_ASSETS at a Hubble that has it. On an older Hubble the sheet has no
// undo, as before, and these are skipped.

const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const rows = (f: FrameLocator) => sheet(f).locator('tr[data-device-row]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const box = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
const pick = (f: FrameLocator, id: string, field: string) => row(f, id).locator('td[data-device-column="' + field + '"]');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
const UNDO = 'ControlOrMeta+z', REDO = 'ControlOrMeta+Shift+z';
type Device = { config: { IP: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const planNames = async (request: APIRequestContext) =>
  ((await (await request.post('/__rpc', { data: { commandId: 'read-plan', value: null } })).json()).result.plan.devices as { id: string; name: string }[]).map(device => device.name);

async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(rows(f).first()).toBeVisible();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(box(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return f;
}
async function typeInto(page: Page, f: FrameLocator, id: string, field: string, text: string) {
  await pick(f, id, field).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ request }) => {
  const runtime = await (await request.get('/api/module-controls/spreadsheet-v1.js')).text();
  test.skip(!runtime.includes('historySupported'), 'These shared controls have no grid undo');
});

test('a typed name and a typed address undo and redo, and nothing reaches a controller', async ({ page, request }) => {
  const f = await open(page, request);
  await typeInto(page, f, MASTER, 'name', 'Truck A');
  await expect(box(f, MASTER, 'name')).toHaveValue('Truck A');
  await expect.poll(() => planNames(request)).toContain('Truck A');
  await page.keyboard.press(UNDO);
  await expect(box(f, MASTER, 'name')).toHaveValue('Master RCP');
  await expect.poll(() => planNames(request)).toContain('Master RCP');
  await page.keyboard.press(REDO);
  await expect(box(f, MASTER, 'name')).toHaveValue('Truck A');

  // An address waits in Pending sends; Undo takes it back out, Redo puts it back.
  await typeInto(page, f, RIO, 'lan1', '10.20.101.250');
  await expect(box(f, RIO, 'lan1')).toHaveValue('10.20.101.250/16');
  await expect(pick(f, RIO, 'lan1')).toHaveClass(/hc-changed/);
  await page.keyboard.press(UNDO);
  await expect(box(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect(pick(f, RIO, 'lan1')).not.toHaveClass(/hc-changed/);
  await page.keyboard.press(REDO);
  await expect(box(f, RIO, 'lan1')).toHaveValue('10.20.101.250/16');
  await expect(pick(f, RIO, 'lan1')).toHaveClass(/hc-changed/);

  // In Auto send too, an address undone or redone waits in Pending sends, as a typed one does.
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await pick(f, RIO, 'lan1').click();
  await page.keyboard.press(UNDO);
  await expect(box(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await page.keyboard.press(UNDO);
  await expect(box(f, MASTER, 'name')).toHaveValue('Master RCP');
  expect((await fleet(request)).flatMap(device => device.actions)).toEqual([]);
});

test('Delete takes an address off; Undo puts it back, and the address goes nowhere', async ({ page, request }) => {
  const f = await open(page, request);
  await pick(f, LEAF, 'lan1').click();
  await page.keyboard.press('Delete');
  await expect(box(f, LEAF, 'lan1')).toHaveValue('');
  await expect(box(f, LEAF, 'lan1')).toHaveAttribute('data-removing', 'true');
  await page.keyboard.press(UNDO);
  await expect(box(f, LEAF, 'lan1')).toHaveValue('10.20.101.202/16');
  await expect(box(f, LEAF, 'lan1')).not.toHaveAttribute('data-removing', 'true');
  await expect(pick(f, LEAF, 'lan1')).not.toHaveClass(/hc-changed/);
  expect((await fleet(request)).flatMap(device => device.actions)).toEqual([]);
});

test('a removed device comes back with Command+Z, in its place, and goes again with Shift+Command+Z', async ({ page, request }) => {
  const f = await open(page, request);
  const order = () => rows(f).evaluateAll(list => list.map(item => (item as HTMLElement).dataset.deviceRow));
  expect(await order()).toEqual([MASTER, LEAF, RIO]);
  await typeInto(page, f, LEAF, 'name', 'Spare RCP');
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  await expect(row(f, LEAF)).toHaveCount(0);
  await pick(f, MASTER, 'name').click();
  await page.keyboard.press(UNDO);
  await expect(row(f, LEAF)).toHaveCount(1);
  expect(await order()).toEqual([MASTER, LEAF, RIO]);
  await expect(box(f, LEAF, 'name')).toHaveValue('Spare RCP');
  await page.keyboard.press(REDO);
  await expect(row(f, LEAF)).toHaveCount(0);
  await page.keyboard.press(UNDO);
  await expect(row(f, LEAF)).toHaveCount(1);
  // Then the rename before it.
  await page.keyboard.press(UNDO);
  await expect(box(f, LEAF, 'name')).toHaveValue('Downstream RCP');
  expect((await fleet(request)).flatMap(device => device.actions)).toEqual([]);
});

test('Undo in one copy of the page leaves a name another copy changed since, and says so', async ({ page, request }) => {
  const one = await open(page, request);
  const second = await page.context().newPage();
  await second.goto('/');
  const two = ui(second);
  await expect(two.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await typeInto(page, one, MASTER, 'name', 'Truck A');
  await expect.poll(() => planNames(request)).toContain('Truck A');
  await expect(box(two, MASTER, 'name')).toHaveValue('Truck A');
  // The other copy renames it again; this copy follows.
  await typeInto(second, two, MASTER, 'name', 'Truck B');
  await expect.poll(() => planNames(request)).toContain('Truck B');
  await expect(box(one, MASTER, 'name')).toHaveValue('Truck B');
  // Undo here would put back what this copy replaced, over the other copy's name: it leaves it.
  await pick(one, LEAF, 'serial').click();
  await page.keyboard.press(UNDO);
  await expect(one.locator('[data-role="toast"]')).toContainText('Name was changed since, so Undo left it as it is');
  await expect(box(one, MASTER, 'name')).toHaveValue('Truck B');
  expect(await planNames(request)).toContain('Truck B');
  await second.close();
});

