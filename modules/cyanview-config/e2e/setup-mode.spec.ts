import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// Setup mode (Nov 21, 2026): while it is on, an RCP added to the list loses its LAN addresses, its WAN settings and
// its cameras, over its base address. RCPs already in the list are cleared from a review. It is never saved.
const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const column = (f: FrameLocator, id: string, name: string) => row(f, id).locator('[data-device-column="' + name + '"]');
const band = (f: FrameLocator) => f.locator('[data-role="setup-band"]');
const modeButton = (f: FrameLocator, mode: 'on' | 'off') => f.locator('[data-action="setup-mode"][data-mode="' + mode + '"]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', DOWNSTREAM = 'CY-RCP-1-30', TRUCK = 'CY-RCP-1-40', CART = 'CY-RCP-1-50';
type Device = { config: { Camera: Record<string, Record<string, any>>; IP: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const addresses = (device: Device) => Object.values(device.config.IP).map(row => row.IP);

// Master RCP has three LAN addresses and a WAN inside 10.192, listed before its base address.
async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true, extra: true, direct: true } });
  await request.post('/__simulate', { data: { editIp: { device: 1, rows: {
    wan: { DHCP: false, DNS1: '10.192.0.2', DNS2: '', Gateway: '10.192.0.1', IP: '10.192.77.5', Interface: 'LAN1', Locked: true, NoDelete: true, ReadOnly: false, Type: 'WAN', mask: '16' },
    second: { IP: '10.20.101.240', Interface: 'LAN1', Type: 'LAN', mask: '16', ReadOnly: false, NoDelete: false, Locked: true },
    third: { IP: '192.168.10.40', Interface: 'LAN1', Type: 'LAN', mask: '24', ReadOnly: false, NoDelete: false, Locked: true },
  } } } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-action="refresh-all"]').click();
  await expect(column(f, MASTER, 'wan')).toHaveText('10.192.77.5/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return f;
}

test('a WAN inside 10.192 is never taken for the base address, and is marked', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(column(f, MASTER, 'base')).toHaveText('10.192.1.20');
  await expect(column(f, MASTER, 'wan').locator('.hc-setup-inside')).toHaveAttribute('title', /inside 10\.192/);
  // The first LAN address the controller lists, whichever it is, and never the WAN or the base.
  await expect(column(f, MASTER, 'lan1').locator('input')).toHaveValue(/^(10\.20\.101\.(201|240)\/16|192\.168\.10\.40\/24)$/);
  await expect(column(f, MASTER, 'connected')).toHaveText('Base');
});

test('Setup mode starts off, clears RCPs already here from a review, and is never saved', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(modeButton(f, 'off')).toHaveAttribute('aria-pressed', 'true');
  await expect(band(f)).toBeHidden();
  await modeButton(f, 'on').click();
  await expect(modeButton(f, 'on')).toHaveAttribute('aria-pressed', 'true');
  await expect(band(f)).toBeVisible();
  await expect(band(f)).toContainText('Every RCP you add is cleared as soon as Hubble reaches it');

  await f.locator('[data-action="review-setup-clear"]').click();
  const dialog = f.locator('.hc-setup-review');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-setup-review]')).toHaveCount(4);
  const master = dialog.locator('.hc-setup-review-item').filter({ hasText: 'Master RCP' });
  // All three, in the order the sheet lists them.
  await expect(master).toContainText(/LAN: deletes (?=[^W]*10\.20\.101\.201\/16)(?=[^W]*10\.20\.101\.240\/16)(?=[^W]*192\.168\.10\.40\/24)/);
  await expect(master).toContainText('WAN: 10.192.77.5/16 (inside the factory network) → Static, no address');
  await expect(master).toContainText('Cameras: deletes 1');
  await expect(dialog).toContainText('RIOs and Gateways aren’t cleared, so Stage RIO isn’t listed.');
  await expect(dialog.locator('[data-action="confirm-setup-clear"]')).toHaveText('Clear 4 RCPs');
  for (const id of [DOWNSTREAM, TRUCK, CART]) await dialog.locator('[data-setup-review="' + id + '"]').uncheck();
  await expect(dialog.locator('[data-action="confirm-setup-clear"]')).toHaveText('Clear 1 RCP');
  await dialog.locator('[data-action="confirm-setup-clear"]').click();

  await expect(column(f, MASTER, 'sync')).toHaveText('Cleared', { timeout: 15000 });
  const [rio, rcp, downstream] = await fleet(request);
  expect(addresses(rcp!).sort()).toEqual(['', '10.192.1.20']);
  expect(rcp!.config.IP.wan).toMatchObject({ DHCP: false, IP: '', Gateway: '', DNS1: '' });
  expect(Object.keys(rcp!.config.Camera)).toEqual([]);
  // Nothing else was touched.
  expect(addresses(rio!)).toContain('10.20.101.200');
  expect(addresses(downstream!)).toContain('10.20.101.202');
  await expect(column(f, MASTER, 'lan1').locator('input')).toHaveValue('');
  await expect(column(f, MASTER, 'wan')).toHaveText('Static');
  await expect(column(f, MASTER, 'cameras')).toHaveText('0');
  await expect(column(f, MASTER, 'connected')).toHaveText('Base');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');

  // Opening the page again finds Setup mode off, and the workspace holds nothing of it.
  await page.reload();
  const again = ui(page);
  await expect(again.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(modeButton(again, 'off')).toHaveAttribute('aria-pressed', 'true');
  await expect(band(again)).toBeHidden();
  const saved = JSON.stringify((await (await request.post('/__rpc', { data: { commandId: 'read-plan', value: null } })).json()).result);
  expect(saved).toContain('CY-RCP-1-20');
  expect(saved.toLowerCase()).not.toContain('setupmode');
  expect(saved).not.toContain('setupChoices');
});

test('an RCP added while Setup mode is on is cleared over its base address, and a RIO is not', async ({ page, request }) => {
  const f = await open(page, request);
  // Both leave the list, which deletes nothing on them, and come back by the address Hubble first reached them by.
  for (const id of [TRUCK, RIO]) { await row(f, id).locator('[data-action="remove-device"]').click(); await expect(row(f, id)).toHaveCount(0); }
  await modeButton(f, 'on').click();
  const add = sheet(f).locator('[data-device-add]');
  await add.fill('10.20.101.203');
  await add.press('Enter');
  await expect(column(f, TRUCK, 'sync')).toHaveText('Cleared', { timeout: 15000 });
  const truck = (await fleet(request))[3]!;
  expect(addresses(truck)).toEqual(['10.192.1.40']);
  await expect(column(f, TRUCK, 'base')).toHaveText('10.192.1.40');
  await expect(column(f, TRUCK, 'connected')).toHaveText('Base');

  await add.fill('10.20.101.200');
  await add.press('Enter');
  await expect(row(f, RIO)).toHaveCount(1);
  await expect(column(f, RIO, 'sync')).toHaveText('In sync');
  expect(addresses((await fleet(request))[0]!)).toContain('10.20.101.200');
  // An RCP already in the list stays as it was.
  expect(addresses((await fleet(request))[2]!)).toContain('10.20.101.202');
});

test('with nothing ticked, an RCP added in Setup mode is left as it is', async ({ page, request }) => {
  const f = await open(page, request);
  await row(f, CART).locator('[data-action="remove-device"]').click();
  await modeButton(f, 'on').click();
  for (const choice of ['lans', 'wan', 'cameras']) await band(f).locator('[data-setup-choice="' + choice + '"]').uncheck();
  await expect(band(f)).toContainText('Nothing is ticked');
  await expect(f.locator('[data-action="review-setup-clear"]')).toBeDisabled();
  const add = sheet(f).locator('[data-device-add]');
  await add.fill('10.192.1.50');
  await add.press('Enter');
  await expect(row(f, CART)).toHaveCount(1);
  await expect(column(f, CART, 'sync')).toHaveText('In sync');
  expect(addresses((await fleet(request))[4]!)).toContain('10.20.101.204');
});

test('an RCP whose base address doesn’t answer is not cleared, and says why', async ({ page, request }) => {
  const f = await open(page, request);
  await row(f, CART).locator('[data-action="remove-device"]').click();
  // Its own address isn't on it, so the clear can only go through its LAN address, which it would delete.
  await request.post('/__simulate', { data: { editIp: { device: 4, rows: { protected: { IP: '10.192.9.9', Interface: 'LAN1', Type: 'Local', mask: '16', ReadOnly: true, NoDelete: true } } } } });
  await modeButton(f, 'on').click();
  const add = sheet(f).locator('[data-device-add]');
  await add.fill('10.20.101.204');
  await add.press('Enter');
  await expect(column(f, CART, 'sync')).toHaveText('Not cleared', { timeout: 15000 });
  await expect(column(f, CART, 'sync').locator('span')).toHaveAttribute('title', /didn’t answer on its base address 10\.192\.1\.50/);
  expect(addresses((await fleet(request))[4]!)).toContain('10.20.101.204');
});
