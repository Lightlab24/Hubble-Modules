import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const named = (scope: Locator, name: string) => scope.locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const cell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const gridOf = (r: Locator) => r.locator('xpath=ancestor::table[1]');
const logins = (f: FrameLocator) => f.locator('[data-role="camera-logins"]');
const saved = (f: FrameLocator) => f.locator('[data-role="saved-devices"]');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const deviceRow = (f: FrameLocator, id: string) => sheet(f).locator('tr[data-device-row="' + id + '"]');
const savedRow = (f: FrameLocator, serial: string) => sheet(f).locator('tr[data-device-saved="' + serial + '"]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30';
const rpc = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const settled = (request: APIRequestContext) => expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
type Device = { config: { Camera: Record<string, Record<string, any>> } };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];

async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}, before?: () => Promise<void>) {
  await request.post('/__reset', { data: { sample: false, remi: true, ...data } });
  await before?.();
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await settled(request);
  return f;
}
async function showSetup(f: FrameLocator) {
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
}
async function choose(f: FrameLocator, r: Locator, column: string, label: string) {
  await cell(r, column).click();
  await gridOf(r).press('Enter');
  const dialog = f.getByRole('dialog', { name: 'Select Camera model' });
  await dialog.getByRole('combobox').fill(label.toLowerCase());
  await dialog.getByRole('option', { name: label, exact: true }).click();
}
async function addLogin(f: FrameLocator, model: string, password: string, username?: string) {
  await logins(f).getByRole('button', { name: 'Add a camera model' }).click();
  const index = await logins(f).locator('tbody tr').count();
  const pick = logins(f).getByRole('button', { name: 'Camera model for login ' + index, exact: true });
  await expect(pick).toBeFocused();
  await pick.click();
  await f.getByRole('listbox', { name: 'Camera model for login ' + index }).getByRole('option', { name: model, exact: true }).click();
  if (username !== undefined) await logins(f).getByRole('textbox', { name: 'Username for ' + model }).fill(username);
  const box = logins(f).getByRole('textbox', { name: 'Password for ' + model });
  await box.fill(password);
  await box.press('Enter');
}

test('Camera logins fill a new camera and a model change, in plain text, and the login goes to the controller', async ({ page, request }) => {
  const f = await open(page, request);
  await showSetup(f);
  const button = setup(f).getByRole('button', { name: /^Camera logins/ });
  await button.click();
  await expect(logins(f)).toBeVisible();
  await expect(logins(f)).toContainText('No logins yet');
  await addLogin(f, 'Burano', 'Burano2026');
  await addLogin(f, 'Venice-IP', 'venice1', 'operator');
  // The models already used aren't offered again.
  await logins(f).getByRole('button', { name: 'Add a camera model' }).click();
  await logins(f).getByRole('button', { name: 'Camera model for login 3', exact: true }).click();
  const third = f.getByRole('listbox', { name: 'Camera model for login 3' });
  await expect(third.getByRole('option', { name: 'Burano', exact: true })).toHaveCount(0);
  await third.press('Escape');
  await logins(f).getByRole('button', { name: 'Remove the login for login 3' }).click();
  await expect(logins(f).locator('tbody tr')).toHaveCount(2);
  await expect(button).toContainText('2');
  // Passwords show as typed.
  await expect(logins(f).getByRole('textbox', { name: 'Password for Burano' })).toHaveValue('Burano2026');
  await f.locator('#hc-setup .hc-toolbar h3').click();
  await expect(logins(f)).toBeHidden();

  // A new row takes the last camera's model, Venice-IP, and its login.
  const rows = setup(f).locator('tbody tr[data-id]'), before = await rows.count();
  await setup(f).locator('[data-count-step="1"]').click();
  await expect(rows).toHaveCount(before + 1);
  const name = await cell(rows.last(), 'name').locator('input').inputValue(), added = named(setup(f), name);
  await expect(cell(added, 'login').locator('input')).toHaveValue('operator');
  await expect(cell(added, 'password').locator('input')).toHaveValue('venice1');
  // Changing the model brings that model's login, and the cells show the change.
  await choose(f, added, 'model', 'Burano');
  await expect(cell(added, 'model')).toContainText('Burano');
  await expect(cell(added, 'login').locator('input')).toHaveValue('admin');
  await expect(cell(added, 'password').locator('input')).toHaveValue('Burano2026');
  await expect(cell(added, 'password')).toHaveClass(/hc-changed/);
  // The selected cell's value reads in plain text too.
  await cell(added, 'password').click();
  await expect(f.locator('[data-camera-value]').first()).toHaveText('Burano2026');
  // Back to Venice-IP, the one model the simulated RIO and Hubble both offer here, brings its login back.
  await choose(f, added, 'model', 'Venice-IP');
  await expect(cell(added, 'login').locator('input')).toHaveValue('operator');
  await expect(cell(added, 'password').locator('input')).toHaveValue('venice1');
  // Typing over the login wins over the saved one.
  await cell(added, 'login').click();
  await gridOf(added).press('Enter');
  await f.locator('input:focus').fill('override');
  await f.locator('input:focus').press('Enter');
  await expect(cell(added, 'login').locator('input')).toHaveValue('override');

  // Kept with the workspace.
  await settled(request);
  const plan = (await rpc(request)('read-plan')).plan;
  expect(plan.cameraLogins).toEqual([{ model: 'Burano', login: 'admin', password: 'Burano2026' }, { model: 'Venice-IP', login: 'operator', password: 'venice1' }]);
  // And still there after the page opens again.
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await showSetup(f);
  await setup(f).getByRole('button', { name: /^Camera logins/ }).click();
  await expect(logins(f).getByRole('textbox', { name: 'Password for Burano' })).toHaveValue('Burano2026');
  await logins(f).press('Escape');
  await expect(logins(f)).toBeHidden();

  // Sent with a Source, the camera reaches its RIO with the login.
  const again = named(setup(f), name);
  await cell(again, 'source').click();
  await gridOf(again).press('Enter');
  await f.getByRole('dialog').getByRole('option', { name: 'Stage RIO', exact: true }).click();
  await cell(again, 'ip').click();
  await gridOf(again).press('Enter');
  await f.locator('input:focus').fill('10.20.20.9');
  await f.locator('input:focus').press('Enter');
  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel.locator('[data-action="send-all-pending"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
  await expect.poll(async () => Object.values((await fleet(request))[0]!.config.Camera).find(camera => camera.Name === name)?.Password).toBe('venice1');
  expect(Object.values((await fleet(request))[0]!.config.Camera).find(camera => camera.Name === name)?.Login).toBe('override');
});

test('every added device is saved, and Discover lists saved devices first, found outside the range, with their names', async ({ page, request }) => {
  const call = rpc(request);
  const f = await open(page, request, { reachAll: true }, async () => {
    // A saved device that is gone: its address answers nothing.
    const read = await call('read-plan');
    await call('save-plan', { revision: read.revision, plan: { ...read.plan, savedDevices: [{ serial: 'CY-RIO-1-99', name: 'Spare RIO', kind: 'RIO', base: '10.192.1.99', address: '' }] } });
  });
  await f.locator('[data-tab="devices"]').click();
  const open_ = f.getByRole('button', { name: /^Saved devices/ });
  await expect(open_).toContainText('4');
  await open_.click();
  await expect(saved(f).locator('tbody tr')).toHaveCount(4);
  for (const serial of [RIO, MASTER, LEAF]) {
    await expect(saved(f).locator('tr[data-saved-device="' + serial + '"]')).toContainText('In this sheet');
    await expect(saved(f).locator('tr[data-saved-device="' + serial + '"] [data-action="forget-saved-device"]')).toBeDisabled();
  }
  await saved(f).getByRole('button', { name: 'Close' }).click();
  await expect(saved(f)).toBeHidden();
  // Taken off the sheet, a device stays saved.
  await deviceRow(f, LEAF).getByRole('button', { name: /Remove/ }).click();
  await deviceRow(f, RIO).getByRole('button', { name: /Remove/ }).click();
  await expect(sheet(f).locator('tr[data-device-row]')).toHaveCount(1);
  await settled(request);
  expect((await call('read-plan')).plan.savedDevices.map((row: any) => row.serial).sort()).toEqual(['CY-RCP-1-20', 'CY-RCP-1-30', 'CY-RIO-1-10', 'CY-RIO-1-99']);

  // 10.20.0.0/16 holds none of the saved devices' factory addresses.
  const range = f.locator('[data-role="scan-bar"] button.hc-dropdown').first();
  await range.click();
  await f.locator('.hc-dropdown-menu').getByRole('option', { name: '10.20.0.0/16' }).click();
  await f.locator('[data-role="scan-bar"] [data-action="scan"]').click();
  await expect(f.locator('[data-role="scan-label"]')).toContainText('Discovery complete');
  const order = await sheet(f).locator('tr.hc-device-found').evaluateAll(list => list.map(row => (row as HTMLElement).dataset.deviceSaved ?? 'sweep'));
  // In the order they were saved: Spare RIO was on the list before this page added the others.
  expect(order.slice(0, 3)).toEqual(['CY-RIO-1-99', RIO, LEAF]);
  await expect(savedRow(f, LEAF)).toContainText('Downstream RCP');
  await expect(savedRow(f, LEAF).locator('.hc-found-tag')).toHaveText('Found');
  await expect(savedRow(f, 'CY-RIO-1-99')).toContainText('Not found');
  await expect(savedRow(f, 'CY-RIO-1-99')).toContainText('stays on the saved list');
  // Added from its saved row, it keeps its saved name.
  await savedRow(f, LEAF).getByRole('button', { name: 'Add Downstream RCP' }).click();
  await expect(deviceRow(f, LEAF).locator('[data-device-setting="name"]')).toHaveValue('Downstream RCP');
  await expect(savedRow(f, LEAF)).toHaveCount(0);

  // Forget takes a device off the saved list only.
  await open_.click();
  await saved(f).getByRole('button', { name: 'Forget Spare RIO' }).click();
  await expect(saved(f).locator('tr[data-saved-device="CY-RIO-1-99"]')).toHaveCount(0);
  await expect(savedRow(f, 'CY-RIO-1-99')).toHaveCount(0);
  await saved(f).press('Escape');
  await settled(request);
  expect((await call('read-plan')).plan.savedDevices.map((row: any) => row.serial).sort()).toEqual(['CY-RCP-1-20', 'CY-RCP-1-30', 'CY-RIO-1-10']);
});

test('saved devices show as Checking the moment Discover is pressed', async ({ page, request }) => {
  const f = await open(page, request, { reachAll: true });
  await f.locator('[data-tab="devices"]').click();
  await deviceRow(f, LEAF).getByRole('button', { name: /Remove/ }).click();
  await settled(request);
  // The search's reply is held, so what shows comes from the page alone.
  await request.post('/__simulate', { data: { pauseState: true } });
  const range = f.locator('[data-role="scan-bar"] button.hc-dropdown').first();
  await range.click();
  await f.locator('.hc-dropdown-menu').getByRole('option', { name: '10.192.0.0/16' }).click();
  await f.locator('[data-role="scan-bar"] [data-action="scan"]').click();
  await expect(savedRow(f, LEAF)).toContainText('Checking…');
  await expect(savedRow(f, LEAF)).toContainText('Downstream RCP');
  await request.post('/__simulate', { data: { pauseState: false } });
  await expect(savedRow(f, LEAF).locator('.hc-found-tag')).toHaveText('Found');
});
