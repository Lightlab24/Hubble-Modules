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
const review = (f: FrameLocator) => f.locator('[data-action="review-foreign"]');

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

  // The camera comes in once, with its settings, its real Source and where it goes.
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  await expect(cell(setup(f).first(), 'ip').locator('input')).toHaveValue('10.20.20.1');
  await expect(cell(setup(f).first(), 'source')).toContainText(RIO);
  // It wasn't configured here, so Hubble says so, once, for the camera and its copies together.
  await expect(review(f)).toHaveText('Review 1 item');
  await expect(f.locator('[data-role="foreign-note"]')).toHaveText('1 thing on this rig wasn’t configured by Hubble');
  await f.locator('[data-tab="assignment"]').click();
  await expect(matrix(f)).toHaveCount(1);
  await expect(circle(matrix(f).first(), LEAF)).toBeChecked();

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

test('what a read turns up is asked about once, and Keep as is changes nothing', async ({ page, request }) => {
  const { f } = await prebuilt(page, request, { [MASTER]: RIO, [LEAF]: MASTER }, [MASTER]);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Added 2 controllers found on the network');
  await f.locator('[data-tab="setup"]').click();
  const written = async () => (await fleet(request)).map(device => device.actions.length), before = await written();
  await review(f).click();
  const dialog = f.getByRole('dialog', { name: 'Not configured by Hubble' });
  await expect(dialog).toContainText('This wasn’t configured by Hubble');
  await expect(dialog).toContainText('1 Wide · set up on ' + RIO);
  await expect(dialog).toContainText('Also on Master RCP and ' + LEAF + ' as REMI copies.');
  await expect(dialog.getByRole('button', { name: 'Keep as is' })).toHaveAttribute('aria-pressed', 'true');

  // Not now leaves the question open.
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(review(f)).toHaveText('Review 1 item');

  await review(f).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(toast(f)).toContainText('Kept 1 as it is');
  await expect(review(f)).toBeHidden();
  expect(await written()).toEqual(before);
  await expect(setup(f)).toHaveCount(1);

  // It isn't asked about again, by another read or after the page is opened again.
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await expect(review(f)).toBeHidden();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  await expect(review(f)).toBeHidden();
});

test('Clear deletes what wasn’t configured by Hubble from its controller, with its copies', async ({ page, request }) => {
  const { f } = await prebuilt(page, request, { [MASTER]: RIO, [LEAF]: MASTER }, [MASTER]);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Added 2 controllers found on the network');
  await f.locator('[data-tab="setup"]').click();
  await review(f).click();
  const dialog = f.getByRole('dialog', { name: 'Not configured by Hubble' });
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await expect(dialog.getByRole('button', { name: 'Clear' })).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(toast(f)).toContainText('Cleared 1');
  for (const serial of [RIO, MASTER, LEAF]) expect(names(await on(request, serial))).toEqual([]);
  await expect(setup(f)).toHaveCount(0);
  await expect(review(f)).toBeHidden();
  // The controllers themselves stay in Devices.
  await f.locator('[data-tab="devices"]').click();
  await expect(deviceRows(f)).toHaveCount(3);
});

test('a copy someone made by hand of a camera Hubble has is its own item, and clearing it takes off only that copy', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = ui(page), rpc = rpcOf(request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f)).toHaveCount(1);
  await expect(review(f)).toBeHidden();
  // Made on the controllers, not through this page.
  const read = await rpc('read-plan'), key = read.plan.cameras.find((camera: any) => camera.device === RIO).elementKey;
  expect((await rpc('remi-route', { items: [{ id: 'x', camera: RIO, key, tree: { [MASTER]: RIO }, expected: {} }] })).results[0].verified).toBe(true);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await expect(review(f)).toHaveText('Review 1 item');
  await review(f).click();
  const dialog = f.getByRole('dialog', { name: 'Not configured by Hubble' });
  await expect(dialog).toContainText('1 Wide on Master RCP · REMI copy');
  await expect(dialog).toContainText('A copy of 1 Wide from Stage RIO.');
  await dialog.getByRole('button', { name: 'Clear' }).click();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(toast(f)).toContainText('Cleared 1');
  expect(names(await on(request, MASTER))).toEqual([]);
  expect(names(await on(request, RIO))).toEqual(['Wide']);
  await expect(setup(f)).toHaveCount(1);
  await expect(review(f)).toBeHidden();
});

test('what Hubble sends itself is never asked about', async ({ page, request }) => {
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
  await expect(review(f)).toBeHidden();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await page.waitForTimeout(800);
  await expect(review(f)).toBeHidden();
});
