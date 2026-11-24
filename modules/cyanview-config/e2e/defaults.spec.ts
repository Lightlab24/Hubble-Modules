import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

// Defaults (0.1.105, asked for Nov 21, 2026): RCPs, RIOs and Gateways numbered separately with gaps,
// names and LAN IPs from %number% patterns, and new cameras named %type% %number% with their address.
const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const rows = (f: FrameLocator) => sheet(f).locator('tr[data-device-row]');
const row = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const cell = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
const tab = (f: FrameLocator) => f.locator('#hc-defaults');
const box = (f: FrameLocator, name: string) => tab(f).getByRole('textbox', { name, exact: true });
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const named = (scope: Locator, name: string) => scope.locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const cameraCell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const gridOf = (r: Locator) => r.locator('xpath=ancestor::table[1]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
const rpc = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const settled = (request: APIRequestContext) => expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
type Device = { config: { Camera: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const order = (f: FrameLocator) => rows(f).evaluateAll(list => list.map(item => (item as HTMLElement).dataset.deviceRow));
const sections = (f: FrameLocator) => sheet(f).locator('tr[data-device-section]').evaluateAll(list => list.map(item => (item as HTMLElement).dataset.deviceSection));

// Opens on the Devices tab with each controller's addresses read from it.
async function open(page: Page, request: APIRequestContext) {
  // The defaults a new workspace starts with, not the empty ones older specs use.
  await request.post('/__reset', { data: { sample: false, remi: true, defaults: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(rows(f).first()).toBeVisible();
  await f.locator('[data-action="refresh-all"]').click();
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await settled(request);
  return f;
}
async function showDefaults(f: FrameLocator) {
  await f.locator('[data-tab="defaults"]').click();
  await expect(tab(f)).toBeVisible();
}
async function type(input: Locator, value: string) {
  await input.fill(value);
  await input.press('Enter');
}

test('RCPs and RIOs are numbered separately with gaps, and a new number brings the name and LAN IP that follow it', async ({ page, request }) => {
  const f = await open(page, request);
  // Each kind has its own section and numbers: an RCP 1 and a RIO 1.
  expect(await sections(f)).toEqual(['RCP', 'RIO']);
  expect(await order(f)).toEqual([MASTER, LEAF, RIO]);
  await expect(cell(f, MASTER, 'row')).toHaveValue('1');
  await expect(cell(f, LEAF, 'row')).toHaveValue('2');
  await expect(cell(f, RIO, 'row')).toHaveValue('1');
  await expect(sheet(f).locator('tr[data-device-section="RIO"]')).toContainText('Name Cam %number% · LAN IP 10.20.101.1%number%');

  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  // RCP 2's LAN IP is what its number makes, so it follows the new number and waits to be sent. Its name was typed, so it stays.
  await type(cell(f, LEAF, 'row'), '5');
  await expect(cell(f, LEAF, 'row')).toHaveValue('5');
  await expect(cell(f, LEAF, 'lan1')).toHaveValue('10.20.101.205/16');
  await expect(row(f, LEAF).locator('[data-device-column="lan1"]')).toHaveClass(/hc-changed/);
  await expect(cell(f, LEAF, 'name')).toHaveValue('Downstream RCP');
  // A number its kind already has is refused and says whose it is. The RIO can still be 5.
  await type(cell(f, MASTER, 'row'), '5');
  await expect(f.locator('[data-role="toast"]')).toContainText('RCP 5 is already Downstream RCP');
  await expect(cell(f, MASTER, 'row')).toHaveValue('1');
  // A name that fits the pattern renumbers the device, and the LAN IP its old number made follows.
  await type(cell(f, MASTER, 'name'), 'RCP 12');
  await expect(cell(f, MASTER, 'row')).toHaveValue('12');
  await expect(cell(f, MASTER, 'lan1')).toHaveValue('10.20.101.212/16');
  // Numbers sort within each kind, with gaps.
  await expect.poll(() => order(f)).toEqual([LEAF, MASTER, RIO]);
  // The RIO's LAN IP was set by hand, so a new number leaves it alone.
  await type(cell(f, RIO, 'row'), '5');
  await expect(cell(f, RIO, 'row')).toHaveValue('5');
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect(cell(f, LEAF, 'row')).toHaveValue('5');
  await request.post('/__simulate', { data: { releasePlanWrites: true } });
  // The saves held behind the first one go out one after another, so the plan is read until the last lands.
  const numbers = async () => Object.fromEntries((await rpc(request)('read-plan')).plan.devices.map((d: { id: string; number: number }) => [d.id, d.number]));
  await expect.poll(numbers).toEqual({ [RIO]: 5, [MASTER]: 12, [LEAF]: 5 });
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  // Nothing went to a controller: the address changes wait in Pending sends.
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('#hc-devices .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(panel).toContainText('10.20.101.205/16');
  await expect(panel).toContainText('10.20.101.212/16');
  await page.reload();
  await expect(rows(f).first()).toBeVisible();
  await expect(cell(f, MASTER, 'row')).toHaveValue('12');
  await expect.poll(() => order(f)).toEqual([LEAF, MASTER, RIO]);
});

test('a device added by hand takes the next number of its kind, the name it makes and its LAN IP in Pending sends', async ({ page, request }) => {
  const f = await open(page, request);
  await showDefaults(f);
  await type(box(f, 'LAN IP for RCPs'), '10.20.102.2%number%');
  await f.locator('[data-tab="devices"]').click();
  await row(f, LEAF).locator('[data-action="remove-device"]').click();
  await expect(rows(f)).toHaveCount(2);
  await type(cell(f, MASTER, 'row'), '7');
  await sheet(f).locator('[data-device-add]').fill('10.192.1.30');
  await sheet(f).locator('[data-device-add]').press('Enter');
  await expect(rows(f)).toHaveCount(3);
  // The next RCP after 7 is 8.
  await expect(cell(f, LEAF, 'row')).toHaveValue('8');
  await expect(cell(f, LEAF, 'name')).toHaveValue('RCP 8');
  await expect(cell(f, LEAF, 'lan1')).toHaveValue('10.20.102.208/16');
  await expect(row(f, LEAF).locator('[data-device-column="lan1"]')).toHaveClass(/hc-changed/);
  await settled(request);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

test('the Defaults tab: + puts a wildcard at the cursor, a pattern that can’t make an address says why, and all of it is saved', async ({ page, request }) => {
  const f = await open(page, request);
  await showDefaults(f);
  const name = box(f, 'Name for RIOs');
  await name.fill('RIO ');
  await name.press('End');
  await tab(f).locator('.hc-defaults-chips [data-action="insert-wildcard"]').click();
  await expect(name).toHaveValue('RIO %number%');
  await expect(name).toBeFocused();
  // The camera name's own + buttons write into it, where the cursor is.
  const cameraName = box(f, 'Camera name');
  await cameraName.fill(' cam');
  await cameraName.evaluate(input => (input as HTMLInputElement).setSelectionRange(0, 0));
  await tab(f).getByRole('button', { name: 'Insert %number%' }).nth(1).click();
  await expect(cameraName).toHaveValue('%number% cam');

  // A pattern that can't make an address is marked and said under its table, and nothing moves.
  const cameras = tab(f).locator('#hc-defaults-cameras'), before = await cameras.boundingBox();
  await type(box(f, 'LAN IP for RIOs'), '10.20.101.123%number%');
  await expect(box(f, 'LAN IP for RIOs')).toHaveAttribute('aria-invalid', 'true');
  await expect(tab(f).locator('[data-role="defaults-device-problems"]')).toContainText('RIOs LAN IP: Put at most two digits beside %number% in an address');
  expect((await cameras.boundingBox())?.y).toBe(before?.y);
  await type(box(f, 'LAN IP for RIOs'), '10.20.101.1%number%');
  await expect(box(f, 'LAN IP for RIOs')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(tab(f).locator('[data-role="defaults-device-problems"]')).toHaveText('');

  // A camera model's row: its type, and a login shown as typed.
  await tab(f).getByRole('button', { name: 'Add a camera model' }).click();
  const pick = tab(f).getByRole('button', { name: 'Camera model 1', exact: true });
  await expect(pick).toBeFocused();
  await pick.click();
  await f.getByRole('listbox', { name: 'Camera model 1' }).getByRole('option', { name: 'Burano', exact: true }).click();
  await type(box(f, '%type% for Burano'), 'BUR');
  await type(box(f, 'Password for Burano'), 'Burano2026');
  await tab(f).getByLabel('A camera added to a RIO takes the RIO’s number').uncheck();
  // Each change saves on its own, so the plan is read until the last one lands.
  await expect.poll(async () => (await rpc(request)('read-plan')).plan.defaults?.camera?.rioNumber).toBe(false);
  const plan = (await rpc(request)('read-plan')).plan;
  expect(plan.defaults.devices.RIO).toEqual({ name: 'RIO %number%', lan: '10.20.101.1%number%', mask: '16' });
  expect(plan.defaults.camera).toEqual({ name: '%number% cam', ip: '10.20.100.1%number%', login: 'admin', rioNumber: false });
  expect(plan.cameraLogins).toEqual([{ model: 'Burano', login: '', password: 'Burano2026', type: 'BUR' }]);
  await page.reload();
  await expect(rows(f).first()).toBeVisible();
  await showDefaults(f);
  await expect(box(f, 'Name for RIOs')).toHaveValue('RIO %number%');
  await expect(box(f, '%type% for Burano')).toHaveValue('BUR');
  await expect(box(f, 'Password for Burano')).toHaveValue('Burano2026');
  await expect(tab(f).getByLabel('A camera added to a RIO takes the RIO’s number')).not.toBeChecked();
  expect((await fleet(request)).map(device => device.actions.length)).toEqual([0, 0, 0]);
});

test('a camera gets its type and number in its name, its address and its login; a RIO gives it its own number', async ({ page, request }) => {
  const f = await open(page, request);
  await showDefaults(f);
  await tab(f).getByRole('button', { name: 'Add a camera model' }).click();
  await tab(f).getByRole('button', { name: 'Camera model 1', exact: true }).click();
  await f.getByRole('listbox', { name: 'Camera model 1' }).getByRole('option', { name: 'Venice-IP', exact: true }).click();
  await type(box(f, '%type% for Venice-IP'), 'V2');
  await type(box(f, 'Username for Venice-IP'), 'operator');
  await type(box(f, 'Password for Venice-IP'), 'venice1');
  // The RIO becomes RIO 14.
  await f.locator('[data-tab="devices"]').click();
  await type(cell(f, RIO, 'row'), '14');

  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
  const list = setup(f).locator('tbody tr[data-id]'), before = await list.count();
  await setup(f).locator('[data-count-step="1"]').click();
  await expect(list).toHaveCount(before + 1);
  // It takes the last camera's model, Venice-IP, so its type, V2, and the next number on the list.
  const first = await cameraCell(list.last(), 'name').locator('input').inputValue();
  const number = await cameraCell(list.last(), 'number').locator('input').inputValue();
  expect(first).toBe('V2 ' + number);
  const added = named(setup(f), first);
  await expect(cameraCell(added, 'ip').locator('input')).toHaveValue('10.20.100.1' + number.padStart(2, '0'));
  await expect(cameraCell(added, 'login').locator('input')).toHaveValue('operator');
  await expect(cameraCell(added, 'password').locator('input')).toHaveValue('venice1');
  // Choosing the RIO as its Source gives it the RIO's number, and its name and address follow.
  await cameraCell(added, 'source').click();
  await gridOf(added).press('Enter');
  await f.getByRole('dialog').getByRole('option', { name: 'Stage RIO', exact: true }).click();
  await expect(named(setup(f), 'V2 14')).toHaveCount(1);
  // Found by its id from here, since its name is about to be typed over.
  const onRio = setup(f).locator('tbody tr[data-id="' + await named(setup(f), 'V2 14').getAttribute('data-id') + '"]');
  await expect(cameraCell(onRio, 'number').locator('input')).toHaveValue('14');
  await expect(cameraCell(onRio, 'ip').locator('input')).toHaveValue('10.20.100.114');
  // A name typed by hand stays when the number changes; the address still follows.
  await cameraCell(onRio, 'name').click();
  await gridOf(onRio).press('Enter');
  await f.locator('input:focus').fill('Jib');
  await f.locator('input:focus').press('Enter');
  const jib = onRio;
  await expect(cameraCell(jib, 'name').locator('input')).toHaveValue('Jib');
  await cameraCell(jib, 'number').click();
  await gridOf(jib).press('Enter');
  await f.locator('input:focus').fill('15');
  await f.locator('input:focus').press('Enter');
  await expect(cameraCell(jib, 'ip').locator('input')).toHaveValue('10.20.100.115');
  await expect(cameraCell(jib, 'name').locator('input')).toHaveValue('Jib');

  // Sent, it reaches the RIO with all of that.
  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
  const sent = async () => Object.values((await fleet(request))[0]!.config.Camera).find(camera => camera.Name === 'Jib');
  await expect.poll(async () => (await sent())?.Number).toBe('15');
  expect((await sent())?.IP).toBe('10.20.100.115');
  expect((await sent())?.Login).toBe('operator');
  expect((await sent())?.Password).toBe('venice1');
});

// Asked for Nov 24, 2026: virtual cameras, such as Cyan - Generic ones made to connect to LiveLab, have no
// address, and a camera had to have one before it could be sent.
test('a camera with no address can be added and sent, and None in a model’s Camera IP gives its cameras none', async ({ page, request }) => {
  const f = await open(page, request);
  await showDefaults(f);
  await tab(f).getByRole('button', { name: 'Add a camera model' }).click();
  await tab(f).getByRole('button', { name: 'Camera model 1', exact: true }).click();
  await f.getByRole('listbox', { name: 'Camera model 1' }).getByRole('option', { name: 'Venice-IP', exact: true }).click();
  await type(box(f, 'Camera IP for Venice-IP'), 'none');
  await expect(box(f, 'Camera IP for Venice-IP')).toHaveValue('None');
  await type(box(f, 'Username for Venice-IP'), 'NONE');
  await expect(box(f, 'Username for Venice-IP')).toHaveValue('None');
  await expect(tab(f).locator('[data-role="defaults-camera-problems"]')).toHaveText('');
  await expect.poll(async () => (await rpc(request)('read-plan')).plan.cameraLogins?.[0]?.ip).toBe('None');

  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
  const list = setup(f).locator('tbody tr[data-id]'), before = await list.count();
  await setup(f).locator('[data-count-step="1"]').click();
  await expect(list).toHaveCount(before + 1);
  const added = setup(f).locator('tbody tr[data-id="' + await list.last().getAttribute('data-id') + '"]');
  const name = await cameraCell(added, 'name').locator('input').inputValue();
  // No address, and it waits to be sent rather than for more typing.
  await expect(cameraCell(added, 'ip').locator('input')).toHaveValue('');
  await expect(cameraCell(added, 'login').locator('input')).toHaveValue('');
  await expect(cameraCell(added, 'sync')).not.toHaveText('Incomplete');
  await cameraCell(added, 'source').click();
  await gridOf(added).press('Enter');
  await f.getByRole('dialog').getByRole('option', { name: 'Stage RIO', exact: true }).click();
  const sentName = await cameraCell(added, 'name').locator('input').inputValue();
  await expect(cameraCell(added, 'ip').locator('input')).toHaveValue('');

  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
  const sent = async () => Object.values((await fleet(request))[0]!.config.Camera).find(camera => camera.Name === sentName);
  await expect.poll(async () => (await sent())?.Model).toBeTruthy();
  expect((await sent())?.IP ?? '').toBe('');
  expect((await sent())?.Login ?? '').toBe('');
  await expect(cameraCell(added, 'sync')).not.toHaveText(/Incomplete|Error|Invalid/);
  expect(name).toBeTruthy();

  // An address that isn't one is still refused, and says why.
  await cameraCell(added, 'ip').click();
  await gridOf(added).press('Enter');
  await f.locator('input:focus').fill('10.20.300');
  await f.locator('input:focus').press('Enter');
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(cameraCell(added, 'sync')).toHaveText('Invalid IP');
  expect((await sent())?.IP ?? '').toBe('');
});

// Asked for Nov 24, 2026: "add other camera defaults like the FX3 over USB, i should just be able to name it".
test('a USB camera model has a Defaults row that names its cameras, with no address or login to fill', async ({ page, request }) => {
  const f = await open(page, request);
  await showDefaults(f);
  await tab(f).getByRole('button', { name: 'Add a camera model' }).click();
  await tab(f).getByRole('button', { name: 'Camera model 1', exact: true }).click();
  await f.getByRole('listbox', { name: 'Camera model 1' }).getByRole('option', { name: 'Alpha-USB', exact: true }).click();
  await type(box(f, '%type% for Alpha-USB'), 'FX3');
  for (const name of ['Camera IP', 'Username', 'Password']) {
    await expect(box(f, name + ' for Alpha-USB')).toBeDisabled();
    await expect(box(f, name + ' for Alpha-USB')).toHaveAttribute('placeholder', '');
  }
  await expect.poll(async () => (await rpc(request)('read-plan')).plan.cameraLogins).toEqual([{ model: 'Alpha-USB', login: '', password: '', type: 'FX3' }]);

  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
  const list = setup(f).locator('tbody tr[data-id]'), before = await list.count();
  await setup(f).locator('[data-count-step="1"]').click();
  await expect(list).toHaveCount(before + 1);
  const added = setup(f).locator('tbody tr[data-id="' + await list.last().getAttribute('data-id') + '"]');
  const number = await cameraCell(added, 'number').locator('input').inputValue();
  // Its model becomes the USB one, and the name follows with the row's type.
  await cameraCell(added, 'model').click();
  await gridOf(added).press('Enter');
  const dialog = f.getByRole('dialog', { name: 'Select Camera model' });
  await dialog.getByRole('option', { name: 'Alpha-USB', exact: true }).click();
  await expect(cameraCell(added, 'name').locator('input')).toHaveValue('FX3 ' + number);
  await expect(cameraCell(added, 'sync')).not.toHaveText('Incomplete');
});
