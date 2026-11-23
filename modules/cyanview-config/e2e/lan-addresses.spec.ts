import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

// Nov 23, 2026: a LAN IP change left RCPs with two LAN1 addresses and the sheet listed one of them; a third
// address had no column at all; nothing could take an address off a device; and RCPs brought in while Setup mode
// was on kept their addresses. Every address is typed with real key presses, as it is on a shoot.
const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const rows = (f: FrameLocator) => sheet(f).locator('tr[data-device-row]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const column = (f: FrameLocator, id: string, name: string) => row(f, id).locator('[data-device-column="' + name + '"]');
const cell = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
const group = (f: FrameLocator, name: string) => sheet(f).locator('thead [data-action="toggle-device-group"][data-group="' + name + '"]');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const toast = (f: FrameLocator) => f.locator('[data-role="toast"]');
const head = (f: FrameLocator) => sheet(f).locator('thead').innerText();
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', DOWNSTREAM = 'CY-RCP-1-30', TRUCK = 'CY-RCP-1-40', CART = 'CY-RCP-1-50';
type Device = { config: { Camera: Record<string, Record<string, any>>; IP: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const addresses = (device: Device) => Object.values(device.config.IP).map(item => item.IP).sort();
const made = (device: Device) => device.actions.filter(action => action.new || action.delete);
const rpc = async (request: APIRequestContext, commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const lan = (ip: string, mask = '16') => ({ IP: ip, Interface: 'LAN1', Type: 'LAN', mask, ReadOnly: false, NoDelete: false, Locked: true });
// A blank entry as a real RCP reported one on Nov 23, 2026: a WAN by type, with nothing on it.
const blank = { DHCP: false, DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: '', Locked: false, NoDelete: false, ReadOnly: false, Type: 'WAN', mask: '' };
const realWan = { DHCP: false, DNS1: '', DNS2: '', Gateway: '', IP: '', Interface: 'LAN1', Locked: true, NoDelete: true, ReadOnly: false, Type: 'WAN', mask: '' };

// A RIO and four RCPs, each with one LAN address, read from the simulated controllers.
async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}, before?: () => Promise<void>) {
  await request.post('/__reset', { data: { sample: false, remi: true, extra: true, ...data } });
  await before?.();
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(rows(f).first()).toBeVisible();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(cell(f, DOWNSTREAM, 'lan1')).toHaveValue('10.20.101.202/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  return f;
}
async function showPending(f: FrameLocator) {
  if (await panel(f).isHidden()) await f.locator('#hc-devices .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(panel(f)).toBeVisible();
}
async function sendAll(f: FrameLocator) {
  await showPending(f);
  await panel(f).locator('[data-action="send-all-pending"]').click();
}
// Real keys: the cell is clicked, its text selected and typed over, and Enter commits it.
async function typeOver(input: Locator, text: string) {
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially(text);
  await input.press('Enter');
}
async function empty(input: Locator) {
  await input.click();
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await input.press('Enter');
}

test('typing over a LAN IP changes that address on the device, which never holds two', async ({ page, request }) => {
  const f = await open(page, request);
  await typeOver(cell(f, DOWNSTREAM, 'lan1'), '10.20.101.222');
  await expect(cell(f, DOWNSTREAM, 'lan1')).toHaveValue('10.20.101.222/16');
  await expect(column(f, DOWNSTREAM, 'lan1')).toHaveClass(/hc-changed/);
  await showPending(f);
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('10.20.101.202/16 → 10.20.101.222/16');
  expect((await fleet(request))[2]!.actions).toHaveLength(0);

  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  const downstream = (await fleet(request))[2]!;
  expect(addresses(downstream)).toEqual(['10.192.1.30', '10.20.101.222']);
  expect(downstream.config.IP.old.IP, 'the element the device already had').toBe('10.20.101.222');
  expect(made(downstream), 'nothing was made and nothing deleted').toEqual([]);
  await expect(cell(f, DOWNSTREAM, 'lan1')).toHaveValue('10.20.101.222/16');
  await expect(column(f, DOWNSTREAM, 'lan1')).not.toHaveClass(/hc-changed/);
  // A read afterwards agrees, and there is no second address.
  await f.locator('[data-action="refresh-all"]').click();
  await expect(toast(f)).toContainText('Settings refreshed');
  await group(f, 'lan').click();
  await expect(cell(f, DOWNSTREAM, 'lan1')).toHaveValue('10.20.101.222/16');
  await expect(cell(f, DOWNSTREAM, 'lan2')).toHaveValue('');
});

test('an address another controller has is refused before anything is written', async ({ page, request }) => {
  const f = await open(page, request);
  // Master RCP has 10.20.101.201. This is what left two addresses behind before.
  await typeOver(cell(f, DOWNSTREAM, 'lan1'), '10.20.101.201');
  await expect(toast(f)).toContainText('10.20.101.201 is already set on Master RCP');
  await sendAll(f);
  await expect(toast(f)).toContainText('10.20.101.201 is already CY-RCP-1-20’s address, so nothing was changed');
  const [, master, downstream] = await fleet(request);
  expect(addresses(downstream!)).toEqual(['10.192.1.30', '10.20.101.202']);
  expect(downstream!.actions).toEqual([]);
  expect(master!.actions).toEqual([]);
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('Could not be confirmed');
  // The change is still there to correct, and a free address goes through.
  await typeOver(cell(f, DOWNSTREAM, 'lan1'), '10.20.101.223');
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  expect(addresses((await fleet(request))[2]!)).toEqual(['10.192.1.30', '10.20.101.223']);
});

test('every LAN address a device has is listed, with a column to spare', async ({ page, request }) => {
  const f = await open(page, request, {}, async () => {
    await request.post('/__simulate', { data: { editIp: { device: 1, rows: { second: lan('10.20.101.240'), third: lan('192.168.10.40', '24') } } } });
  });
  // Folded away, the one column counts the rest, and the address beside the count sits where the others do.
  expect(await head(f)).not.toContain('LAN IP 2');
  const more = column(f, MASTER, 'lan1').locator('.hc-device-more');
  await expect(more).toHaveText('+2 more');
  await expect(more).toHaveAttribute('title', /10\.20\.101\.201\/16|192\.168\.10\.40\/24/);
  await expect(column(f, DOWNSTREAM, 'lan1').locator('.hc-device-more')).toHaveCount(0);
  const left = async (id: string) => (await cell(f, id, 'lan1').boundingBox())!.x;
  expect(await left(MASTER)).toBe(await left(DOWNSTREAM));

  await more.click();
  await expect(group(f, 'lan')).toHaveAttribute('aria-expanded', 'true');
  for (const label of ['LAN IP 2', 'LAN IP 3', 'LAN IP 4']) expect(await head(f)).toContain(label);
  expect(await head(f)).not.toContain('LAN IP 5');
  const listed = async (id: string) => (await Promise.all(['lan1', 'lan2', 'lan3', 'lan4'].map(field => cell(f, id, field).inputValue()))).filter(Boolean).sort();
  expect(await listed(MASTER)).toEqual(['10.20.101.201/16', '10.20.101.240/16', '192.168.10.40/24']);
  expect(await listed(DOWNSTREAM)).toEqual(['10.20.101.202/16']);

  // The spare column adds another address to any device, as its next one.
  await typeOver(cell(f, DOWNSTREAM, 'lan4'), '10.20.101.232');
  await expect(cell(f, DOWNSTREAM, 'lan2')).toHaveValue('10.20.101.232/16');
  await showPending(f);
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('LAN IP 2');
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  expect(addresses((await fleet(request))[2]!)).toEqual(['10.192.1.30', '10.20.101.202', '10.20.101.232']);

  // An address put on a device outside Hubble is on the sheet after a read, and the sheet grows a column for it.
  await request.post('/__simulate', { data: { editIp: { device: 1, rows: { fourth: lan('172.16.5.5') } } } });
  await f.locator('[data-action="refresh-all"]').click();
  await expect.poll(() => listed(MASTER)).toContain('172.16.5.5/16');
  expect(await head(f)).toContain('LAN IP 5');
});

test('emptying a LAN IP takes that address off the device once sent, and typing it back cancels', async ({ page, request }) => {
  const f = await open(page, request, {}, async () => {
    await request.post('/__simulate', { data: { editIp: { device: 1, rows: { second: lan('10.20.101.240'), third: lan('192.168.10.40', '24') } } } });
  });
  await group(f, 'lan').click();
  const values = async () => Promise.all(['lan1', 'lan2', 'lan3'].map(field => cell(f, MASTER, field).inputValue()));
  const field = 'lan' + ((await values()).indexOf('192.168.10.40/24') + 1);
  await empty(cell(f, MASTER, field));
  await expect(cell(f, MASTER, field)).toHaveValue('');
  // The address stays readable in its cell, struck through, until it is sent.
  await expect(cell(f, MASTER, field)).toHaveAttribute('placeholder', '192.168.10.40');
  await expect(cell(f, MASTER, field)).toHaveAttribute('data-removing', 'true');
  await expect(column(f, MASTER, field)).toHaveClass(/hc-changed/);
  await showPending(f);
  const line = panel(f).locator('[data-pending-lan-line]');
  await expect(line).toContainText('192.168.10.40/24 → Removed');
  expect((await fleet(request))[1]!.actions, 'nothing goes until Send').toEqual([]);

  // Typing the address back puts it as it was.
  await typeOver(cell(f, MASTER, field), '192.168.10.40/24');
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  await expect(column(f, MASTER, field)).not.toHaveClass(/hc-changed/);

  await empty(cell(f, MASTER, field));
  await expect(line).toContainText('192.168.10.40/24 → Removed');
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  const master = (await fleet(request))[1]!;
  expect(addresses(master)).toEqual(['10.192.1.20', '10.20.101.201', '10.20.101.240']);
  expect(master.actions).toEqual([{ delete: ['third'] }]);
  // The addresses left close up, and the sheet needs one column fewer.
  expect((await values()).filter(Boolean).sort()).toEqual(['10.20.101.201/16', '10.20.101.240/16']);
  await expect(cell(f, MASTER, 'lan3')).toHaveValue('');
  expect(await head(f)).not.toContain('LAN IP 4');
});

test('an address an earlier version left behind mid-change is listed, not hidden', async ({ page, request }) => {
  const f = await open(page, request);
  // What a failed change left: the old address, a second one beside it, and the row still pointing at the second.
  const saved = await rpc(request, 'read-plan');
  const old = saved.plan.lans.find((item: any) => item.device === DOWNSTREAM && item.elementKey === 'old');
  expect(old, 'the saved row for Downstream RCP’s LAN address').toBeTruthy();
  old.newElementKey = 'halfway';
  await request.post('/__simulate', { data: { editIp: { device: 2, rows: { halfway: lan('10.20.101.209') } } } });
  expect((await (await request.post('/__rpc', { data: { commandId: 'save-plan', value: { revision: saved.revision, plan: saved.plan } } })).json()).result?.revision).toBeTruthy();
  await page.reload();
  const again = ui(page);
  await expect(again.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await again.locator('[data-action="refresh-all"]').click();
  await expect(column(again, DOWNSTREAM, 'lan1').locator('.hc-device-more')).toHaveText('+1 more');
  await group(again, 'lan').click();
  const listed = (await Promise.all(['lan1', 'lan2'].map(field => cell(again, DOWNSTREAM, field).inputValue()))).sort();
  expect(listed).toEqual(['10.20.101.202/16', '10.20.101.209/16']);
});

test('a blank entry is listed apart from the WAN and can be removed', async ({ page, request }) => {
  // Listed before the device's real WAN, as a controller lists its rows in no fixed order.
  const f = await open(page, request, {}, async () => {
    await request.post('/__simulate', { data: { editIp: { device: 1, rows: { leftover: blank, wan: realWan } } } });
  });
  await expect(column(f, MASTER, 'wan')).toHaveText('Static');
  await group(f, 'lan').click();
  const entry = row(f, MASTER).locator('.hc-device-blank');
  await expect(entry).toHaveText('Blank entry');
  // It comes after the device's addresses, so the first column is still an address.
  await expect(cell(f, MASTER, 'lan1')).toHaveValue('10.20.101.201/16');
  const remove = row(f, MASTER).locator('[data-action="remove-device-address"]');
  await expect(remove).toHaveAttribute('title', /blank address entry/);
  await remove.click();
  await expect(entry).toHaveClass(/hc-device-removing/);
  await expect(remove).toHaveCount(0);
  await showPending(f);
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('Blank entry → Removed');
  expect((await fleet(request))[1]!.actions).toEqual([]);
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  const master = (await fleet(request))[1]!;
  expect(Object.keys(master.config.IP).sort()).toEqual(['old', 'protected', 'wan']);
  expect(master.actions).toEqual([{ delete: ['leftover'] }]);
  await expect(row(f, MASTER).locator('.hc-device-blank')).toHaveCount(0);
  await expect(cell(f, MASTER, 'lan1')).toHaveValue('10.20.101.201/16');
  await expect(column(f, MASTER, 'wan')).toHaveText('Static');
});

test('Setup mode clears an RCP’s addresses even when one of its cameras can’t be deleted', async ({ page, request }) => {
  const f = await open(page, request, { direct: true }, async () => {
    await request.post('/__simulate', { data: { editIp: { device: 1, rows: { leftover: blank, wan: { ...realWan, IP: '10.30.1.5', mask: '16', Gateway: '10.30.0.1' } } } } });
  });
  await request.post('/__simulate', { data: { refuseCameraDeletes: { device: 1 } } });
  await f.locator('[data-action="setup-mode"][data-mode="on"]').click();
  await f.locator('[data-action="review-setup-clear"]').click();
  const dialog = f.locator('.hc-setup-review');
  await expect(dialog.locator('.hc-setup-review-item').filter({ hasText: 'Master RCP' })).toContainText('LAN: deletes 10.20.101.201/16 and 1 blank entry');
  for (const id of [DOWNSTREAM, TRUCK, CART]) await dialog.locator('[data-setup-review="' + id + '"]').uncheck();
  await dialog.locator('[data-action="confirm-setup-clear"]').click();
  const sync = column(f, MASTER, 'sync');
  await expect(sync).toHaveText('Not cleared', { timeout: 15000 });
  await expect(sync.locator('span')).toHaveAttribute('title', /1 camera is still on it; its addresses were cleared/);
  const master = (await fleet(request))[1]!;
  expect(Object.keys(master.config.IP).sort(), 'only its base address and its WAN are left').toEqual(['protected', 'wan']);
  expect(master.config.IP.wan).toMatchObject({ DHCP: false, IP: '', Gateway: '' });
  expect(Object.keys(master.config.Camera)).toEqual(['direct']);
  await expect(cell(f, MASTER, 'lan1')).toHaveValue('');
  await expect(column(f, MASTER, 'wan')).toHaveText('Static');
});

test('while Setup mode is on nothing joins the list by itself, and each RCP added is cleared', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true, extra: true } });
  // Only the RIO and one RCP are in the list. The other three RCPs are on the network, where each controller lists them.
  const saved = await rpc(request, 'read-plan'), keep = [RIO, DOWNSTREAM];
  const plan = { ...saved.plan, devices: saved.plan.devices.filter((item: any) => keep.includes(item.id)), cameras: saved.plan.cameras.filter((item: any) => keep.includes(item.device)), lans: [] };
  expect((await (await request.post('/__rpc', { data: { commandId: 'save-plan', value: { revision: saved.revision, plan } } })).json()).result?.revision).toBeTruthy();
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(rows(f)).toHaveCount(2);
  await f.locator('[data-action="setup-mode"][data-mode="on"]').click();
  await expect(f.locator('[data-role="setup-band"]')).toContainText('Nothing joins the list by itself while this is on');

  const add = sheet(f).locator('[data-device-add]');
  await add.click();
  await add.pressSequentially('10.20.101.201');
  await add.press('Enter');
  await expect(column(f, MASTER, 'sync')).toHaveText('Cleared', { timeout: 15000 });
  expect(addresses((await fleet(request))[1]!)).toEqual(['10.192.1.20']);
  // The search for the rest of the rig used to add the other RCPs here, uncleared.
  await page.waitForTimeout(2500);
  await expect(rows(f)).toHaveCount(3);
  await expect(row(f, TRUCK)).toHaveCount(0);
  expect(addresses((await fleet(request))[3]!)).toEqual(['10.192.1.40', '10.20.101.203']);

  // Each one added by hand is cleared like the first.
  await add.click();
  await add.pressSequentially('10.20.101.203');
  await add.press('Enter');
  await expect(column(f, TRUCK, 'sync')).toHaveText('Cleared', { timeout: 15000 });
  expect(addresses((await fleet(request))[3]!)).toEqual(['10.192.1.40']);
  await page.waitForTimeout(1500);
  await expect(row(f, CART)).toHaveCount(0);

  // With Setup mode off, a read finds the last one again and adds it as it is.
  await f.locator('[data-action="setup-mode"][data-mode="off"]').click();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(row(f, CART)).toHaveCount(1, { timeout: 15000 });
  expect(addresses((await fleet(request))[4]!)).toEqual(['10.192.1.50', '10.20.101.204']);
});
