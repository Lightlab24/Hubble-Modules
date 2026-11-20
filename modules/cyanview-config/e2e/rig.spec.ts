import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
type Device = { config: { Product: { Serial: string }; Camera: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const on = async (request: APIRequestContext, serial: string) => (await fleet(request)).find(device => device.config.Product.Serial === serial)!;
const names = (device: Device) => Object.values(device.config.Camera).map(camera => camera.Name);
const rpcOf = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const deviceRows = (f: FrameLocator) => f.locator('[data-role="device-sheet"] tr[data-device-row]');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"] tbody tr[data-id]');
const matrix = (f: FrameLocator) => f.locator('[data-controller="__all-cameras__"] tbody tr[data-id]');
const cell = (r: Locator, column: string) => r.locator('td[data-column="' + column + '"]');
const circle = (r: Locator, id: string) => cell(r, 'remi:' + id).locator('[role="checkbox"]');
const toast = (f: FrameLocator) => f.locator('[data-role="toast"]');
// Cameras Cyanview has that Hubble didn't set up, listed apart from yours until they are moved in.
const outside = (f: FrameLocator) => f.locator('[data-role="outside"]');
const outsideRows = (f: FrameLocator) => outside(f).locator('tbody tr');
async function showPending(f: FrameLocator) {
  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  return panel;
}
async function sendAll(f: FrameLocator) {
  const panel = await showPending(f);
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
}

// A rig built by hand on the controllers: the RIO's camera REMI'd on to RCPs. Hubble is only given some of it.
async function prebuilt(page: Page, request: APIRequestContext, tree: Record<string, string>, keep: string[], data: Record<string, unknown> = {}) {
  await request.post('/__reset', { data: { sample: false, remi: true, ...data } });
  const rpc = rpcOf(request);
  let read = await rpc('read-plan');
  const key = read.plan.cameras.find((camera: any) => camera.device === RIO).elementKey;
  const routed = await rpc('remi-route', { items: [{ id: 'x', camera: RIO, key, tree, expected: {} }] });
  expect(routed.results[0].verified, routed.results[0].error).toBe(true);
  read = await rpc('read-plan');
  await rpc('save-plan', { revision: read.revision, plan: { ...read.plan, devices: read.plan.devices.filter((device: any) => keep.includes(device.id)), cameras: read.plan.cameras.filter((camera: any) => keep.includes(camera.device)) } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return { f, rpc };
}

test('Refresh all brings in the rest of a rig set up outside Hubble, by reading only, and a controller removed by hand stays out', async ({ page, request }) => {
  const { f } = await prebuilt(page, request, { [MASTER]: RIO, [LEAF]: MASTER }, [MASTER]);
  await f.locator('[data-tab="devices"]').click();
  await expect(deviceRows(f)).toHaveCount(1);
  const written = async () => (await fleet(request)).map(device => device.actions.length), before = await written();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Added 2 controllers found on the network');
  await expect(deviceRows(f)).toHaveCount(3);
  expect(await written()).toEqual(before);

  // The camera comes in once, with its settings and its real Source, apart from the cameras Hubble set up.
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(0);
  await expect(outsideRows(f)).toHaveCount(1);
  await expect(outsideRows(f).first()).toContainText('10.20.20.1');
  await expect(outsideRows(f).first()).toContainText(RIO);
  await expect(outside(f).locator('[data-role="outside-summary"]')).toHaveText('1 camera');
  await f.locator('[data-tab="assignment"]').click();
  await expect(matrix(f)).toHaveCount(0);
  // Moved in, it is one of yours, with where it goes, and nothing is sent.
  await f.locator('[data-tab="setup"]').click();
  await outside(f).getByRole('button', { name: 'Move 1 Wide to my cameras' }).click();
  await expect(outside(f)).toBeHidden();
  await expect(setup(f)).toHaveCount(1);
  await expect(cell(setup(f).first(), 'ip').locator('input')).toHaveValue('10.20.20.1');
  await f.locator('[data-tab="assignment"]').click();
  await expect(matrix(f)).toHaveCount(1);
  await expect(circle(matrix(f).first(), LEAF)).toBeChecked();
  expect(await written()).toEqual(before);

  // Removed by hand, a controller is not brought back by the next read, here or after the page is opened again.
  await f.locator('[data-tab="devices"]').click();
  await f.locator('[data-role="device-sheet"] tr[data-device-row="' + LEAF + '"] [data-action="remove-device"]').click();
  await expect(deviceRows(f)).toHaveCount(2);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await page.waitForTimeout(1500);
  await expect(deviceRows(f)).toHaveCount(2);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="devices"]').click();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await page.waitForTimeout(1500);
  await expect(deviceRows(f)).toHaveCount(2);
});

test('what a read turns up waits apart, Move makes it yours without sending anything, and it stays yours', async ({ page, request }) => {
  const { f } = await prebuilt(page, request, { [MASTER]: RIO, [LEAF]: MASTER }, [MASTER]);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Added 2 controllers found on the network');
  await f.locator('[data-tab="setup"]').click();
  const written = async () => (await fleet(request)).map(device => device.actions.length), before = await written();
  const row = outsideRows(f).first();
  await expect(row).toContainText('Wide');
  await expect(row).toContainText(RIO);
  await expect(row.getByRole('button', { name: 'Clear 1 Wide' })).toBeVisible();
  await outside(f).getByRole('button', { name: 'Move all to my cameras' }).click();
  await expect(toast(f)).toContainText('1 Wide is now one of your cameras');
  await expect(outside(f)).toBeHidden();
  expect(await written()).toEqual(before);
  await expect(setup(f)).toHaveCount(1);

  // It isn't listed apart again, by another read or after the page is opened again.
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await expect(outside(f)).toBeHidden();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  await expect(outside(f)).toBeHidden();
});

test('Clear marks what Hubble didn’t set up, Keep takes that back, and Send deletes it from its controller with its copies', async ({ page, request }) => {
  const { f } = await prebuilt(page, request, { [MASTER]: RIO, [LEAF]: MASTER }, [MASTER]);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Added 2 controllers found on the network');
  await f.locator('[data-tab="setup"]').click();
  const written = async () => (await fleet(request)).map(device => device.actions.length), before = await written();
  const row = outsideRows(f).first();
  await row.getByRole('button', { name: 'Clear 1 Wide' }).click();
  await expect(row).toHaveClass(/hc-remove-staged/);
  await expect(row.getByRole('button', { name: 'Move 1 Wide to my cameras' })).toBeDisabled();
  await row.getByRole('button', { name: 'Keep 1 Wide' }).click();
  await expect(row).not.toHaveClass(/hc-remove-staged/);
  await outside(f).getByRole('button', { name: 'Clear all' }).click();
  await expect(row).toHaveClass(/hc-remove-staged/);
  // It waits in Pending sends like any delete.
  await showPending(f);
  await expect(f.locator('[data-role="pending-sends"] [data-pending-line="delete"]')).toContainText('Deleted from ' + RIO);
  expect(await written()).toEqual(before);
  await sendAll(f);
  for (const serial of [RIO, MASTER, LEAF]) expect(names(await on(request, serial))).toEqual([]);
  await expect(outside(f)).toBeHidden();
  await expect(setup(f)).toHaveCount(0);
  // The controllers themselves stay in Devices.
  await f.locator('[data-tab="devices"]').click();
  await expect(deviceRows(f)).toHaveCount(3);
});

test('a copy someone made by hand of a camera Hubble has is listed apart, and Clear takes off only that copy', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = ui(page), rpc = rpcOf(request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  await expect(outside(f)).toBeHidden();
  // Made on the controllers, not through this page.
  const read = await rpc('read-plan'), key = read.plan.cameras.find((camera: any) => camera.device === RIO).elementKey;
  expect((await rpc('remi-route', { items: [{ id: 'x', camera: RIO, key, tree: { [MASTER]: RIO }, expected: {} }] })).results[0].verified).toBe(true);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await expect(outsideRows(f)).toHaveCount(1);
  await expect(outsideRows(f).first()).toContainText('Copy on Master RCP · of 1 Wide');
  await outsideRows(f).first().getByRole('button', { name: 'Clear 1 Wide' }).click();
  await showPending(f);
  await expect(f.locator('[data-role="pending-sends"] [data-pending-line="remi:' + MASTER + '"]')).toContainText('On → Off');
  await sendAll(f);
  expect(names(await on(request, MASTER))).toEqual([]);
  expect(names(await on(request, RIO))).toEqual(['Wide']);
  await expect(setup(f)).toHaveCount(1);
  await expect(outside(f)).toBeHidden();
});

test('what Hubble sends itself is never listed apart', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = ui(page), panel = f.locator('[data-role="pending-sends"]');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await circle(matrix(f).first(), MASTER).click();
  if (await panel.isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
  expect(names(await on(request, MASTER))).toEqual(['Wide']);
  await f.locator('[data-tab="setup"]').click();
  await expect(outside(f)).toBeHidden();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await page.waitForTimeout(800);
  await expect(outside(f)).toBeHidden();
});

test('a camera someone adds on an RCP Hubble manages is listed apart and left out of the counts until it is moved in', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  // Added in Cyanview's own page, not here.
  await request.post('/__simulate', { data: { addCamera: { device: 1, key: 'crane', row: { Number: '7', Name: 'Crane', Model: 'Sony - Venice-IP', IP: '10.20.30.7', Port: '80', Enabled: '1' } } } });
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await expect(outsideRows(f)).toHaveCount(1);
  await expect(outsideRows(f).first()).toContainText('Crane');
  await expect(outsideRows(f).first()).toContainText('Master RCP');
  await expect(setup(f)).toHaveCount(1);
  await expect(f.locator('[data-tab="setup"] .hc-tab-count')).toHaveText('1');
  await expect(f.locator('[data-tab="assignment"] .hc-tab-count')).toHaveText('1');
  await outsideRows(f).first().getByRole('button', { name: 'Move 7 Crane to my cameras' }).click();
  await expect(outside(f)).toBeHidden();
  await expect(setup(f)).toHaveCount(2);
  await expect(f.locator('[data-tab="setup"] .hc-tab-count')).toHaveText('2');
  expect(names(await on(request, MASTER))).toEqual(['Crane']);
});
