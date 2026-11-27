import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const rows = (f: FrameLocator) => sheet(f).locator('tr[data-device-row]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const cell = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
// The cell itself. A click selects it, as in every grid; its box takes the mouse only while it is typed in.
const pick = (f: FrameLocator, id: string, field: string) => row(f, id).locator('td[data-device-column="' + field + '"]');
// Where the keyboard is: the box being typed in, or else the grid's cell in use.
const keyboardAt = (f: FrameLocator) => f.locator('body').evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  if (active?.dataset?.deviceCell) return active.dataset.deviceCell;
  const cell = active?.matches('[data-role="device-sheet"]') ? active.querySelector<HTMLElement>('td[data-hubble-spreadsheet-active="true"]') : null;
  return cell ? cell.dataset.hubbleRow + ':' + cell.dataset.hubbleColumn : active?.tagName;
});
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
  // The sheet is the only view: no Sheet/Details switch, no per-device cards and no finder card.
  await expect(f.locator('[data-device-view]')).toHaveCount(0);
  await expect(f.locator('[data-network-controller]')).toHaveCount(0);
  await expect(f.locator('[data-role="device-discovery"]')).toHaveCount(0);

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

  // Sorting reorders the devices, a second click reverses it, and the REMI Matrix follows. RCPs and RIOs
  // keep their own sections (0.1.105), so each section is sorted on its own, and they start in number order.
  expect(await order(f)).toEqual([MASTER, LEAF, RIO]);
  await expect(sheet(f).locator('[data-device-sort="row"]')).toContainText('↑');
  await sheet(f).locator('[data-device-sort="name"]').click();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await sheet(f).locator('[data-device-sort="base"]').click();
  expect(await order(f)).toEqual([MASTER, LEAF, RIO]);
  await sheet(f).locator('[data-device-sort="base"]').click();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(rows(f).first()).toBeVisible();
  expect(await order(f)).toEqual([LEAF, MASTER, RIO]);
  await expect(group(f, 'wan')).toHaveAttribute('aria-expanded', 'true');
  await expect(group(f, 'lan')).toHaveAttribute('aria-expanded', 'false');
});

// A number typed in # renumbers the device since 0.1.105; defaults.spec.ts covers it, with the save held.

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
  await expect(row(f, MASTER).locator('[data-device-column="lan1"] .hc-device-more')).toHaveText('+1 more');
  await expect(row(f, MASTER).locator('[data-device-column="lan1"] .hc-device-more')).toHaveAttribute('data-pending', 'true');
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

// The RIO's WAN starts on DHCP, and the commands are the ones a real RIO WAN's own page sent on Nov 17, 2026.
test('a WAN goes Static with an address and gateway through Pending sends, and back to DHCP', async ({ page, request }) => {
  const f = await open(page, request, { wan: true });
  await group(f, 'wan').click();
  const mode = cell(f, RIO, 'wanMode'), address = cell(f, RIO, 'wanIp'), gateway = cell(f, RIO, 'gateway');
  await expect(mode).toHaveValue('DHCP');
  await expect(address).toBeDisabled();
  await expect(gateway).toBeDisabled();

  await mode.selectOption('Static');
  await expect(address).toBeEnabled();
  await expect(row(f, RIO).locator('[data-device-column="wanMode"]')).toHaveClass(/hc-changed/);
  await address.fill('10.20.101.102');
  await address.press('Enter');
  // The mask comes from the LAN address beside it.
  await expect(address).toHaveValue('10.20.101.102/16');
  await gateway.fill('10.20.100.1');
  await gateway.press('Enter');
  await showPending(f);
  const line = panel(f).locator('[data-pending-lan-line]');
  await expect(line).toContainText('WAN');
  await expect(line).toContainText('DHCP → 10.20.101.102/16 · gateway 10.20.100.1');
  expect((await fleet(request))[0]!.actions).toHaveLength(0);

  await panel(f).locator('[data-pending-lan-send]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  let rio = (await fleet(request))[0]!;
  expect(rio.config.IP.wan).toMatchObject({ DHCP: false, IP: '10.20.101.102', mask: '16', Gateway: '10.20.100.1' });
  expect(rio.actions).toEqual([
    { update: { changes: { dhcp: 'no' }, key: 'wan' } },
    { update: { key: 'wan', changes: { ip: '10.20.101.102' } } },
    { update: { key: 'wan', changes: { mask: '16' } } },
    { update: { key: 'wan', changes: { gateway: '10.20.100.1' } } },
  ]);
  await expect(mode).toHaveValue('Static');
  await expect(row(f, RIO).locator('[data-device-column="wanMode"]')).not.toHaveClass(/hc-changed/);
  await expect(row(f, RIO).locator('[data-device-column="wanIp"]')).not.toHaveClass(/hc-changed/);

  // DHCP blanks the address and gateway at once. Picking Static again before sending drops the change.
  await mode.selectOption('DHCP');
  await expect(address).toHaveValue('');
  await expect(gateway).toHaveValue('');
  await expect(gateway).toBeDisabled();
  await expect(line).toContainText('10.20.101.102/16 → DHCP · gateway blank');
  await mode.selectOption('Static');
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  await expect(address).toHaveValue('10.20.101.102/16');
  await expect(gateway).toHaveValue('10.20.100.1');

  await mode.selectOption('DHCP');
  await panel(f).locator('[data-pending-lan-send]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  rio = (await fleet(request))[0]!;
  expect(rio.config.IP.wan).toMatchObject({ DHCP: true, IP: '', mask: '', Gateway: '' });
  expect(rio.actions.slice(4)).toEqual([{ update: { changes: { dhcp: 'yes', dns: '', dns2: '', gateway: '', ip: '', mask: '' }, key: 'wan' } }]);
  await expect(mode).toHaveValue('DHCP');
  await group(f, 'wan').click();
  await expect(row(f, RIO).locator('[data-device-column="wan"]')).toHaveText('DHCP');
});

// Every change redraws the sheet. Committing it while the focus was moving left nothing focused, so
// typing after Tab or a click went nowhere, and Enter dropped the focus on purpose (Nov 17, 2026).
test('Tab, a click and Enter keep the keyboard in the sheet, and Enter moves down', async ({ page, request }) => {
  const f = await open(page, request, { wan: true });
  await group(f, 'wan').click();
  await group(f, 'lan').click();
  const focusedCell = () => keyboardAt(f);
  await cell(f, RIO, 'wanMode').selectOption('Static');
  await pick(f, RIO, 'wanIp').click();
  await page.keyboard.type('10.20.101.102');
  await page.keyboard.press('Tab');
  await expect.poll(focusedCell).toBe(RIO + ':gateway');
  await page.keyboard.type('10.20.100.1');
  await expect(cell(f, RIO, 'gateway')).toHaveValue('10.20.100.1');
  await expect(cell(f, RIO, 'wanIp')).toHaveValue('10.20.101.102/16');
  // A click on another cell keeps it.
  await pick(f, RIO, 'dns1').click();
  await expect.poll(focusedCell).toBe(RIO + ':dns1');
  await page.keyboard.type('10.20.100.2');
  await expect(cell(f, RIO, 'gateway')).toHaveValue('10.20.100.1');
  await expect(row(f, RIO).locator('[data-device-column="gateway"]')).toHaveClass(/hc-changed/);
  // Enter moves down the column.
  await pick(f, MASTER, 'lan2').click();
  await page.keyboard.type('10.20.101.212');
  await page.keyboard.press('Enter');
  await expect.poll(focusedCell).toBe(LEAF + ':lan2');
  await expect(cell(f, MASTER, 'lan2')).toHaveValue('10.20.101.212/16');
  await page.keyboard.type('10.20.101.213');
  await page.keyboard.press('Enter');
  // Enter goes on past the RIOs' section heading to the RIO, the last row, which keeps its cell.
  await expect.poll(focusedCell).toBe(RIO + ':lan2');
  await expect(cell(f, LEAF, 'lan2')).toHaveValue('10.20.101.213/16');
  await page.keyboard.type('10.20.101.214');
  await page.keyboard.press('Enter');
  await expect.poll(focusedCell).toBe(RIO + ':lan2');
  await expect(cell(f, RIO, 'lan2')).toHaveValue('10.20.101.214/16');
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

// A controller reports every change to its settings, and each report redraws the sheet. The redraw used
// to rebuild the cell being typed in, which made the browser commit the half-typed text: an unfinished
// address was refused and cleared, and a name was saved half-typed and lost the keyboard (Nov 17, 2026).
async function controllerReportsAChange(request: APIRequestContext, name: string) {
  const key = Object.keys((await fleet(request))[0]!.config.Camera)[0]!;
  await request.post('/__simulate', { data: { editCamera: { device: 0, key, fields: { Name: name } } } });
  // The page has read the change, redrawn and saved once the new name is in the saved plan.
  await expect.poll(async () => ((await rpcOf(request)('read-plan')).plan.cameras as { name: string }[]).some(camera => camera.name === name)).toBe(true);
}
const focusedCell = (f: FrameLocator) => keyboardAt(f);

test('a change reported by a controller leaves the cell being typed in alone', async ({ page, request }) => {
  const f = await open(page, request, { wan: true, live: true });
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).openSockets).toEqual([1, 1, 1]);
  await group(f, 'wan').click();
  await cell(f, RIO, 'wanMode').selectOption('Static');
  await expect(cell(f, RIO, 'wanIp')).toBeEnabled();
  const toast = f.locator('[data-role="toast"]');
  for (const [index, [field, start, rest, committed]] of ([['wanIp', '10.20.', '101.102', '10.20.101.102/16'], ['name', 'Cam 1', ' Rio', 'Cam 1 Rio'], ['gateway', '10.20.', '100.1', '10.20.100.1'], ['lan1', '10.20.10', '1.210', '10.20.101.210/16']] as const).entries()) {
    await pick(f, RIO, field).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(start);
    // The same box stays in the page, so the caret and the text are exactly where they were.
    await cell(f, RIO, field).evaluate(element => { (window as any).__typingIn = element; });
    await controllerReportsAChange(request, 'Reported ' + index);
    expect(await focusedCell(f)).toBe(RIO + ':' + field);
    expect(await cell(f, RIO, field).evaluate(element => element === (window as any).__typingIn)).toBe(true);
    await expect(cell(f, RIO, field)).toHaveValue(start);
    expect(await cell(f, RIO, field).evaluate(element => (element as HTMLInputElement).selectionStart)).toBe(start.length);
    await expect(toast).toBeHidden();
    // Nothing was committed from the half-typed text.
    const half = (await rpcOf(request)('read-plan')).plan;
    expect(half.devices.find((device: { id: string }) => device.id === RIO).name).not.toBe('Cam 1');
    await page.keyboard.type(rest);
    await page.keyboard.press('Tab');
    await expect(cell(f, RIO, field)).toHaveValue(committed);
  }
  // Tab from the name goes on to the next cell, Type, and stays there: the remove button is not a cell.
  await pick(f, MASTER, 'name').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Truck A');
  await page.keyboard.press('Tab');
  await expect(cell(f, MASTER, 'name')).toHaveValue('Truck A');
  await expect.poll(() => focusedCell(f)).toBe(MASTER + ':type');
  // A cell nobody is typing in follows what its controller reports.
  await pick(f, LEAF, 'name').click();
  await controllerReportsAChange(request, 'Reported last');
  expect(await focusedCell(f)).toBe(LEAF + ':name');
  await expect.poll(async () => (await rpcOf(request)('read-plan')).plan.devices.map((device: { name: string }) => device.name)).toEqual(['Cam 1 Rio', 'Truck A', 'Downstream RCP']);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

test('typing goes on in the next cell while a save is held, and after it lands', async ({ page, request }) => {
  const f = await open(page, request, { wan: true });
  await group(f, 'wan').click();
  await cell(f, RIO, 'wanMode').selectOption('Static');
  await expect(cell(f, RIO, 'wanIp')).toBeEnabled();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  await pick(f, RIO, 'name').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Cam 1 Rio');
  await pick(f, RIO, 'wanIp').click();
  await page.keyboard.type('10.20.1');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Saving');
  expect(await focusedCell(f)).toBe(RIO + ':wanIp');
  await expect(cell(f, RIO, 'wanIp')).toHaveValue('10.20.1');
  await request.post('/__simulate', { data: { releasePlanWrites: true } });
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  expect(await focusedCell(f)).toBe(RIO + ':wanIp');
  await page.keyboard.type('01.102');
  await expect(cell(f, RIO, 'wanIp')).toHaveValue('10.20.101.102');
  await page.keyboard.press('Enter');
  await expect(cell(f, RIO, 'wanIp')).toHaveValue('10.20.101.102/16');
  await expect(cell(f, RIO, 'name')).toHaveValue('Cam 1 Rio');
  // Escape puts back what a cell held.
  await pick(f, RIO, 'gateway').click();
  await page.keyboard.type('10.99');
  await page.keyboard.press('Escape');
  await expect(cell(f, RIO, 'gateway')).toHaveValue('');
  await page.keyboard.press('Tab');
  await expect(row(f, RIO).locator('[data-device-column="gateway"]')).not.toHaveClass(/hc-changed/);
  await expect(f.locator('[data-role="toast"]')).toBeHidden();
});

test('a cell typed in while its device is sending keeps the keyboard, and its text goes in after the send', async ({ page, request }) => {
  const f = await open(page, request, { wan: true });
  await group(f, 'wan').click();
  await cell(f, RIO, 'wanMode').selectOption('Static');
  await pick(f, RIO, 'wanIp').click();
  await page.keyboard.type('10.20.101.102');
  await page.keyboard.press('Tab');
  await showPending(f);
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('10.20.101.102/16');
  await request.post('/__simulate', { data: { holdAction: 'update' } });
  await pick(f, RIO, 'gateway').click();
  await page.keyboard.type('10.20.');
  // A send reaches this device while the cell is in use, as one queued behind other devices does.
  // Starting it from the page leaves the keyboard where it is.
  await panel(f).locator('[data-pending-lan-send]').evaluate(button => (button as HTMLElement).click());
  // The rest of the row waits for the send. The cell in use doesn't.
  await expect(cell(f, RIO, 'dns2')).toBeDisabled();
  await expect(cell(f, RIO, 'gateway')).toBeEnabled();
  expect(await focusedCell(f)).toBe(RIO + ':gateway');
  await page.keyboard.type('100.1');
  await expect(cell(f, RIO, 'gateway')).toHaveValue('10.20.100.1');
  await page.keyboard.press('Enter');
  // Committed mid-send, it shows and waits for the send to finish.
  await expect(cell(f, RIO, 'gateway')).toHaveValue('10.20.100.1');
  await expect(row(f, RIO).locator('[data-device-column="gateway"]')).toHaveClass(/hc-changed/);
  expect(await focusedCell(f)).toBe(RIO + ':gateway');
  await request.post('/__simulate', { data: { holdAction: '', releaseReplies: true } });
  await expect.poll(async () => (await fleet(request))[0]!.config.IP.wan).toMatchObject({ DHCP: false, IP: '10.20.101.102' });
  // Then it is an edit like any other, waiting in Pending sends.
  await expect(panel(f).locator('[data-pending-lan-line]')).toContainText('gateway 10.20.100.1');
  await expect(cell(f, RIO, 'gateway')).toHaveValue('10.20.100.1');
  await expect(cell(f, RIO, 'dns2')).toBeEnabled();
  expect((await fleet(request))[0]!.config.IP.wan.Gateway ?? '').not.toBe('10.20.100.1');
  await panel(f).locator('[data-pending-lan-send]').click();
  await expect.poll(async () => (await fleet(request))[0]!.config.IP.wan).toMatchObject({ Gateway: '10.20.100.1' });
});

test('a WAN on Static can be sent with no address', async ({ page, request }) => {
  const f = await open(page, request, { wan: true });
  await group(f, 'wan').click();
  await cell(f, RIO, 'wanMode').selectOption('Static');
  await expect(cell(f, RIO, 'wanIp')).toHaveValue('');
  await showPending(f);
  const line = panel(f).locator('[data-pending-lan-line]');
  await expect(line).toContainText('DHCP → Blank');
  await panel(f).locator('[data-pending-lan-send]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  const rio = (await fleet(request))[0]!;
  expect(rio.config.IP.wan).toMatchObject({ DHCP: false, IP: '' });
  expect(rio.actions).toEqual([{ update: { changes: { dhcp: 'no' }, key: 'wan' } }]);
  await expect(cell(f, RIO, 'wanMode')).toHaveValue('Static');
  await expect(row(f, RIO).locator('[data-device-column="wanMode"]')).not.toHaveClass(/hc-changed/);
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
  // The finder's controls sit in the toolbar, and there is no other finder.
  await expect(f.locator('[data-role="scan-bar"] [data-role="scan-range"]')).toHaveCount(1);
  await expect(f.locator('[data-role="scan-bar"] [data-action="scan"]')).toBeVisible();
  await expect(f.locator('[data-action="add-ip"]')).toHaveCount(0);
  await f.locator('[data-device-add]').fill('10.192.1.30');
  await f.locator('[data-device-add]').press('Enter');
  await expect(rows(f)).toHaveCount(3);
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  // A search lists what it finds as rows in the sheet, each with its own Add, and Add all.
  await f.getByRole('button', { name: 'Network range', exact: true }).click();
  await f.getByRole('listbox', { name: 'Network range' }).getByRole('option', { name: 'Custom range…', exact: true }).click();
  await f.getByRole('textbox', { name: 'Custom CIDR range', exact: true }).fill('10.192.1.30/32');
  await f.getByRole('button', { name: 'Discover', exact: true }).click();
  const found = sheet(f).locator('tr[data-device-found]');
  await expect(found).toHaveCount(1);
  await expect(found).toContainText('CY-RCP-1-30');
  await expect(f.locator('[data-action="add-all-found"]')).toHaveText('Add all 1');
  await found.getByRole('button', { name: /^Add / }).click();
  await expect(rows(f)).toHaveCount(3);
  await expect(found).toHaveCount(0);
});

const openedPages = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).openedPages as string[];

test('a controller’s address opens its own web page: the Base IP is the link, a typed address has a button', async ({ page, request }) => {
  const f = await open(page, request);
  const base = row(f, MASTER).locator('[data-device-column="base"] button');
  await expect(base).toHaveText('10.192.1.20');
  await expect(base).toHaveAttribute('title', 'Open 10.192.1.20 in Safari');
  await base.click();
  await expect.poll(() => openedPages(request)).toEqual(['10.192.1.20']);
  // The click also picks the row, as any click in it does.
  await expect(row(f, MASTER)).toHaveClass(/hc-device-selected/);

  // A LAN address stays a box to type in. Its button only shows with the pointer or the keyboard in the cell.
  const lan = row(f, RIO).locator('[data-device-column="lan1"]'), opener = lan.locator('button.hc-ip-open');
  await expect(opener).toBeHidden();
  await pick(f, RIO, 'lan1').click();
  await expect.poll(() => keyboardAt(f)).toBe(RIO + ':lan1');
  expect(await openedPages(request)).toEqual(['10.192.1.20']);
  // The cell in use shows it even once the pointer has gone.
  await page.mouse.move(0, 0);
  await expect(opener).toBeVisible();
  await expect(opener).toHaveAttribute('title', 'Open 10.20.101.200 in Safari');
  await opener.click();
  await expect.poll(() => openedPages(request)).toEqual(['10.192.1.20', '10.20.101.200']);
  // Opening it leaves the keyboard on that cell, and Tab never stops on the button.
  await expect.poll(() => keyboardAt(f)).toBe(RIO + ':lan1');
  await page.keyboard.press('Tab');
  expect(await f.locator('body').evaluate(() => (document.activeElement as HTMLElement)?.className ?? '')).not.toContain('hc-ip-open');

  // The keyboard reaches the link too.
  await row(f, LEAF).locator('[data-device-column="base"] button').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => openedPages(request)).toEqual(['10.192.1.20', '10.20.101.200', '10.192.1.30']);
  // Nothing was sent to a controller and nothing waits to be.
  await expect(panel(f)).toBeHidden();
  expect((await fleet(request)).flatMap(device => device.actions)).toEqual([]);
});

test('an address that is typed but not sent yet opens the one the device still has, and a browser that won’t open says so', async ({ page, request }) => {
  const f = await open(page, request);
  await cell(f, RIO, 'lan1').fill('10.20.101.250/16');
  await pick(f, RIO, 'name').click();
  await expect(row(f, RIO).locator('[data-device-column="lan1"]')).toHaveClass(/hc-changed/);
  await row(f, RIO).locator('[data-device-column="lan1"]').hover();
  await row(f, RIO).locator('[data-device-column="lan1"] button.hc-ip-open').click();
  await expect.poll(() => openedPages(request)).toEqual(['10.20.101.200']);

  await request.post('/__simulate', { data: { openPageError: 'The browser could not be opened' } });
  await row(f, MASTER).locator('[data-device-column="base"] button').click();
  await expect(f.locator('[data-role="toast"]')).toHaveText('The browser could not be opened');
  expect(await openedPages(request)).toEqual(['10.20.101.200']);
  // The sheet is as it was: the typed address still waits, and the link is still there.
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.250/16');
  await expect(row(f, MASTER).locator('[data-device-column="base"] button')).toHaveText('10.192.1.20');
});
