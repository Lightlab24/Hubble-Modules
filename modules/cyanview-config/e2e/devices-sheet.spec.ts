import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const rows = (f: FrameLocator) => sheet(f).locator('tr[data-device-row]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const cell = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
const group = (f: FrameLocator, name: string) => sheet(f).locator('[data-action="toggle-device-group"][data-group="' + name + '"]');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
type Device = { config: { Camera: Record<string, Record<string, any>>; IP: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const names = (device: Device) => Object.values(device.config.Camera).map(camera => camera.Name);
const rpcOf = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const order = (f: FrameLocator) => rows(f).evaluateAll(list => list.map(item => (item as HTMLElement).dataset.deviceRow));

// Opens on the Devices tab with each controller's addresses read from it.
async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}) {
  await request.post('/__reset', { data: { sample: false, remi: true, ...data } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(rows(f).first()).toBeVisible();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return f;
}
async function showPending(f: FrameLocator) {
  if (await panel(f).isHidden()) await f.locator('#hc-devices .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(panel(f)).toBeVisible();
}

test('Devices is one sheet with a row per controller, and its groups and sort are remembered', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(rows(f)).toHaveCount(3);
  const head = () => sheet(f).locator('thead').innerText();
  for (const label of ['Name', 'Type', 'Serial', 'Status', 'Base IP', 'LAN IP settings', 'WAN settings', 'Connected on', 'Cameras', 'Sync']) expect(await head()).toContain(label);
  await expect(row(f, RIO).locator('[data-device-column="base"]')).toHaveText('10.192.1.10');
  await expect(row(f, RIO).locator('[data-device-column="connected"]')).toHaveText('Base');
  await expect(row(f, RIO).locator('[data-device-column="cameras"] .hc-device-camera-count')).toHaveText('1');
  // The old per-device cards and their finder stay out of the way.
  await expect(f.locator('[data-network-controller]').first()).toBeHidden();
  await expect(f.locator('[data-role="device-discovery"]')).toBeHidden();

  // Each group opens on its own.
  expect(await head()).not.toContain('LAN IP 2');
  await expect(group(f, 'lan')).toHaveAttribute('aria-expanded', 'false');
  await group(f, 'lan').click();
  await expect(group(f, 'lan')).toHaveAttribute('aria-expanded', 'true');
  expect(await head()).toContain('LAN IP 2');
  expect(await head()).not.toContain('Gateway');
  await group(f, 'wan').click();
  for (const label of ['Mode', 'WAN IP', 'Gateway', 'DNS 1', 'DNS 2']) expect(await head()).toContain(label);
  await group(f, 'lan').click();
  expect(await head()).not.toContain('LAN IP 2');

  // Sorting reorders the devices, a second click reverses it, and the REMI Matrix follows.
  expect(await order(f)).toEqual([RIO, MASTER, LEAF]);
  await sheet(f).locator('[data-device-sort="name"]').click();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await sheet(f).locator('[data-device-sort="base"]').click();
  expect(await order(f)).toEqual([RIO, MASTER, LEAF]);
  await sheet(f).locator('[data-device-sort="base"]').click();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(rows(f).first()).toBeVisible();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await expect(group(f, 'wan')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(f, 'lan')).toHaveAttribute('aria-expanded', 'false');

  // Details still has each device's own network card.
  await f.locator('[data-device-view="details"]').click();
  await expect(f.locator('[data-network-controller]')).toHaveCount(3);
  await expect(sheet(f)).toBeHidden();
  await f.locator('[data-device-view="sheet"]').click();
  await expect(rows(f)).toHaveCount(3);
});

test('a device is renamed in its Name cell, with the save held', async ({ page, request }) => {
  const f = await open(page, request);
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  const name = cell(f, MASTER, 'name');
  await name.fill('Truck A');
  await name.press('Enter');
  await expect(cell(f, MASTER, 'name')).toHaveValue('Truck A');
  // A second edit lands while the first save is still held.
  await cell(f, LEAF, 'name').fill('Truck B');
  await cell(f, LEAF, 'name').press('Enter');
  await expect(cell(f, LEAF, 'name')).toHaveValue('Truck B');
  await request.post('/__simulate', { data: { releasePlanWrites: true } });
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const plan = (await rpcOf(request)('read-plan')).plan;
  expect(plan.devices.map((device: { name: string }) => device.name).sort()).toEqual(['Stage RIO', 'Truck A', 'Truck B']);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

test('an address typed into LAN IP 2 waits in Pending sends, can be cancelled, and Send adds it', async ({ page, request }) => {
  const f = await open(page, request);
  await group(f, 'lan').click();
  const second = cell(f, MASTER, 'lan2');
  await second.fill('10.20.101.212');
  await second.press('Enter');
  // The mask comes from the address it sits beside.
  await expect(cell(f, MASTER, 'lan2')).toHaveValue('10.20.101.212/16');
  await expect(row(f, MASTER).locator('[data-device-column="lan2"]')).toHaveClass(/hc-changed/);
  await expect(row(f, MASTER).locator('[data-device-column="sync"]')).toHaveText('Pending');
  await showPending(f);
  const line = panel(f).locator('[data-pending-lan-line]');
  await expect(line).toContainText('LAN IP 2');
  await expect(line).toContainText('Blank → 10.20.101.212/16');
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);

  // Collapsed, the group still says something is waiting.
  await group(f, 'lan').click();
  await expect(row(f, MASTER).locator('[data-device-column="lan1"]')).toContainText('+1 pending');
  await group(f, 'lan').click();

  await line.getByRole('button').click();
  await expect(cell(f, MASTER, 'lan2')).toHaveValue('');
  await expect(panel(f)).toContainText('Nothing is waiting to send');

  // A bad address is refused, and Auto send doesn't send an address by itself.
  await cell(f, MASTER, 'lan2').fill('10.20.999.1');
  await cell(f, MASTER, 'lan2').press('Enter');
  await expect(f.locator('[data-role="toast"]')).toContainText('Enter an address such as');
  await expect(cell(f, MASTER, 'lan2')).toHaveValue('');
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await cell(f, MASTER, 'lan2').fill('10.20.101.212/16');
  await cell(f, MASTER, 'lan2').press('Enter');
  await expect(line).toBeVisible();
  expect((await fleet(request))[1]!.actions).toHaveLength(0);

  await panel(f).locator('[data-pending-lan-send]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  await expect(cell(f, MASTER, 'lan2')).toHaveValue('10.20.101.212/16');
  await expect(row(f, MASTER).locator('[data-device-column="lan2"]')).not.toHaveClass(/hc-changed/);
  const after = await fleet(request);
  expect(Object.values(after[1]!.config.IP).map(item => item.IP)).toContain('10.20.101.212');
  expect(after[0]!.actions).toHaveLength(0);

  // Refresh all throws away an address still waiting.
  await cell(f, LEAF, 'lan2').fill('10.20.101.213');
  await cell(f, LEAF, 'lan2').press('Enter');
  await expect(line).toBeVisible();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  await expect(cell(f, LEAF, 'lan2')).toHaveValue('');
});

test('a device is added by typing its IP in the last row', async ({ page, request }) => {
  const f = await open(page, request);
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  await expect(rows(f)).toHaveCount(2);
  const add = sheet(f).locator('[data-device-add]'), note = sheet(f).locator('[data-role="device-add-note"]');
  await add.fill('not an ip');
  await add.press('Enter');
  await expect(note).toContainText('not a valid IP address');
  await sheet(f).locator('[data-device-add]').fill('10.192.1.20');
  await sheet(f).locator('[data-device-add]').press('Enter');
  await expect(note).toContainText('already in the list as Master RCP');
  await expect(rows(f)).toHaveCount(2);
  await sheet(f).locator('[data-device-add]').fill('10.192.1.30');
  await sheet(f).locator('[data-device-add]').press('Enter');
  await expect(rows(f)).toHaveCount(3);
  await expect(row(f, LEAF).locator('[data-device-column="base"]')).toHaveText('10.192.1.30');
  await expect(cell(f, LEAF, 'lan1')).toHaveValue('10.20.101.202/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  expect((await rpcOf(request)('read-plan')).plan.devices.map((device: { id: string }) => device.id)).toContain(LEAF);
  // Several pasted at once are each looked up.
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  await row(f, RIO).locator('[data-action="remove-device"]').click();
  await expect(rows(f)).toHaveCount(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('10.192.1.30\n10.192.1.10'));
  await sheet(f).locator('[data-device-add]').click();
  await page.keyboard.press((await page.evaluate(() => /Mac/.test(navigator.platform)) ? 'Meta' : 'Control') + '+v');
  await expect(rows(f)).toHaveCount(3);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

test('Clear all cameras asks first, then deletes every camera on that controller', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  // Jib lives on Master RCP and is also sent on to Downstream RCP.
  const reply = await request.post('/__rpc', { data: { commandId: 'remi-send', value: { receiver: LEAF, items: [{ id: 'direct', kind: 'camera', source: MASTER, key: 'direct', enable: true }] } } });
  expect((await reply.json()).result.results[0].verified).toBe(true);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(row(f, LEAF).locator('[data-device-column="cameras"] .hc-device-camera-count')).toHaveText('1');
  const clear = row(f, LEAF).getByRole('button', { name: 'Clear all cameras on Downstream RCP' });

  // A controller that only holds a copy loses the copy, and the camera stays where it lives.
  await expect(clear).toHaveText('Clear all');
  const before = (await fleet(request)).map(device => device.actions.length);
  await clear.click();
  const dialog = f.getByRole('dialog', { name: 'Clear all cameras on Downstream RCP' });
  await expect(dialog).toContainText('Deletes all 1 camera configuration from Downstream RCP');
  await expect(dialog).toContainText('is a copy of a camera set up on another controller');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
  await clear.click();
  await dialog.getByRole('button', { name: 'Delete 1 camera', exact: true }).click();
  await expect(f.locator('[data-role="toast"]')).toContainText('All cameras cleared from Downstream RCP');
  await expect(row(f, LEAF).locator('[data-device-column="cameras"] .hc-device-camera-count')).toHaveText('0');
  let after = await fleet(request);
  expect(names(after[2]!)).toEqual([]);
  expect(names(after[1]!)).toEqual(['Jib']);

  // Put the copy back, then clear the controller the camera lives on: the copy goes with it.
  const again = await request.post('/__rpc', { data: { commandId: 'remi-send', value: { receiver: LEAF, items: [{ id: 'direct', kind: 'camera', source: MASTER, key: 'direct', enable: true }] } } });
  expect((await again.json()).result.results[0].verified).toBe(true);
  await f.locator('[data-action="refresh-all"]').click();
  await expect(row(f, LEAF).locator('[data-device-column="cameras"] .hc-device-camera-count')).toHaveText('1');
  await row(f, MASTER).getByRole('button', { name: 'Clear all cameras on Master RCP' }).click();
  const master = f.getByRole('dialog', { name: 'Clear all cameras on Master RCP' });
  await expect(master).toContainText('also on other RCPs');
  await master.getByRole('button', { name: 'Delete 1 camera', exact: true }).click();
  await expect(f.locator('[data-role="toast"]')).toContainText('All cameras cleared from Master RCP');
  after = await fleet(request);
  expect(names(after[1]!)).toEqual([]);
  expect(names(after[2]!)).toEqual([]);
  expect(names(after[0]!)).toEqual(['Wide']);
  await expect(row(f, MASTER).locator('[data-action="clear-device-cameras"]')).toHaveCount(0);
  expect((await rpcOf(request)('read-plan')).plan.cameras.map((camera: { name: string }) => camera.name)).toEqual(['Wide']);
});

test('Clear all cameras also clears a copy whose camera can’t be reached, and one nothing imports any more', async ({ page, request }) => {
  const f = await open(page, request);
  const rpc = rpcOf(request);
  const sent = await rpc('remi-send', { receiver: MASTER, items: [{ id: 'wide', kind: 'camera', source: RIO, key: 'wide', enable: true }] });
  expect(sent.results[0].verified).toBe(true);
  // An imported camera that no REMI connection on the controller points at any more.
  await request.post('/__simulate', { data: { addCamera: { device: 1, key: 'stray', row: { Number: '9', Name: 'Stray', Model: 'Cyan - Imported' } } } });
  await f.locator('[data-action="refresh-all"]').click();
  await expect(row(f, MASTER).locator('[data-device-column="cameras"] .hc-device-camera-count')).toHaveText('2');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  // The RIO the first copy comes from drops off the network.
  const { revision, plan } = await rpc('read-plan');
  Object.assign(plan.devices.find((device: { id: string }) => device.id === RIO), { base: '10.99.99.99', alias: '', address: '10.99.99.99' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await expect(rows(f).first()).toBeVisible();
  await row(f, MASTER).getByRole('button', { name: 'Clear all cameras on Master RCP' }).click();
  await f.getByRole('dialog').getByRole('button', { name: 'Delete 2 cameras', exact: true }).click();
  await expect(f.locator('[data-role="toast"]')).toContainText('All cameras cleared from Master RCP', { timeout: 15000 });
  const after = await fleet(request);
  expect(names(after[1]!)).toEqual([]);
  // The camera itself is untouched on its own controller.
  expect(names(after[0]!)).toEqual(['Wide']);
});

test('finding devices is one line in the toolbar, and a found device lists as a row to add', async ({ page, request }) => {
  const f = await open(page, request);
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  await expect(rows(f)).toHaveCount(2);
  // The finder's card stays out of the sheet view; its controls sit in the toolbar.
  await expect(f.locator('[data-role="device-discovery"]')).toBeHidden();
  await expect(f.locator('[data-role="scan-bar"] [data-role="scan-range"]')).toHaveCount(1);
  await f.locator('[data-device-add]').fill('10.192.1.30');
  await f.locator('[data-device-add]').press('Enter');
  await expect(rows(f)).toHaveCount(3);
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  // The Details view keeps the finder, with Add on each found device and Add all.
  await f.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(f.locator('[data-role="device-discovery"]')).toBeVisible();
  await f.locator('[data-action="add-ip"]').click();
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.30');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-role="discovery-results"]').getByRole('button', { name: 'Add CY-RCP-1-30' })).toBeVisible();
  await expect(f.locator('[data-action="add-discovered"]')).toHaveText('Add all 1');
  await f.getByRole('button', { name: 'Sheet', exact: true }).click();
  const found = sheet(f).locator('tr[data-device-found]');
  await expect(found).toHaveCount(1);
  await expect(found).toContainText('CY-RCP-1-30');
  await found.getByRole('button', { name: /^Add / }).click();
  await expect(rows(f)).toHaveCount(3);
  await expect(found).toHaveCount(0);
});
