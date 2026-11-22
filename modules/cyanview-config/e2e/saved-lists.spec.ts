import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const named = (scope: Locator, name: string) => scope.locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const cell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const gridOf = (r: Locator) => r.locator('xpath=ancestor::table[1]');
const logins = (f: FrameLocator) => f.locator('#hc-defaults');
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
async function showDefaults(f: FrameLocator) {
  await f.locator('[data-tab="defaults"]').click();
  await expect(logins(f)).toBeVisible();
}
// Camera logins live in the camera model rows on the Defaults tab since 0.1.105.
async function addLogin(f: FrameLocator, model: string, password: string, username?: string) {
  await logins(f).getByRole('button', { name: 'Add a camera model' }).click();
  const index = await logins(f).locator('tbody tr[data-defaults-type]').count();
  const pick = logins(f).getByRole('button', { name: 'Camera model ' + index, exact: true });
  await expect(pick).toBeFocused();
  await pick.click();
  await f.getByRole('listbox', { name: 'Camera model ' + index }).getByRole('option', { name: model, exact: true }).click();
  if (username !== undefined) await logins(f).getByRole('textbox', { name: 'Username for ' + model }).fill(username);
  const box = logins(f).getByRole('textbox', { name: 'Password for ' + model });
  await box.fill(password);
  await box.press('Enter');
}

test('Camera logins fill a new camera and a model change, in plain text, and the login goes to the controller', async ({ page, request }) => {
  const f = await open(page, request, { defaults: true });
  await showDefaults(f);
  await expect(logins(f)).toContainText('No camera models yet');
  await addLogin(f, 'Burano', 'Burano2026');
  await addLogin(f, 'Venice-IP', 'venice1', 'operator');
  // The models already used aren't offered again.
  await logins(f).getByRole('button', { name: 'Add a camera model' }).click();
  await logins(f).getByRole('button', { name: 'Camera model 3', exact: true }).click();
  const third = f.getByRole('listbox', { name: 'Camera model 3' });
  await expect(third.getByRole('option', { name: 'Burano', exact: true })).toHaveCount(0);
  await third.press('Escape');
  await logins(f).getByRole('button', { name: 'Remove the row for row 3' }).click();
  await expect(logins(f).locator('tbody tr[data-defaults-type]')).toHaveCount(2);
  // Passwords show as typed.
  await expect(logins(f).getByRole('textbox', { name: 'Password for Burano' })).toHaveValue('Burano2026');
  // The Camera logins button that used to sit on Camera Configuration is gone.
  await showSetup(f);
  await expect(setup(f).getByRole('button', { name: /^Camera logins/ })).toHaveCount(0);

  // A new row takes the last camera's model, Venice-IP, and its login.
  const rows = setup(f).locator('tbody tr[data-id]'), before = await rows.count();
  await setup(f).locator('[data-count-step="1"]').click();
  await expect(rows).toHaveCount(before + 1);
  const name = await cell(rows.last(), 'name').locator('input').inputValue(), added = named(setup(f), name);
  await expect(cell(added, 'login').locator('input')).toHaveValue('operator');
  await expect(cell(added, 'password').locator('input')).toHaveValue('venice1');
  // Changing the model brings that model's login, and the cells show the change. Burano has no username
  // of its own, so it takes the one Defaults gives every model.
  await choose(f, added, 'model', 'Burano');
  const burano = named(setup(f), name.replace('Venice-IP', 'Burano'));
  await expect(cell(burano, 'model')).toContainText('Burano');
  await expect(cell(burano, 'login').locator('input')).toHaveValue('admin');
  await expect(cell(burano, 'password').locator('input')).toHaveValue('Burano2026');
  await expect(cell(burano, 'password')).toHaveClass(/hc-changed/);
  // The selected cell's value reads in plain text too.
  await cell(burano, 'password').click();
  await expect(f.locator('[data-camera-value]').first()).toHaveText('Burano2026');
  // Back to Venice-IP, the one model the simulated RIO and Hubble both offer here, brings its login back.
  await choose(f, burano, 'model', 'Venice-IP');
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
  expect(plan.cameraLogins).toEqual([{ model: 'Burano', login: '', password: 'Burano2026' }, { model: 'Venice-IP', login: 'operator', password: 'venice1' }]);
  // And still there after the page opens again.
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await showDefaults(f);
  await expect(logins(f).getByRole('textbox', { name: 'Password for Burano' })).toHaveValue('Burano2026');
  await showSetup(f);

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

test('every added device is saved by serial with no name, and Discover lists saved devices first, found outside the range', async ({ page, request }) => {
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
  // A device is named for the job it is on, so the saved list goes by serial and keeps no name.
  expect(await saved(f).locator('thead th').allInnerTexts()).toEqual(['Serial', 'Type', 'Address', '', '']);
  await expect(saved(f)).not.toContainText('Spare RIO');
  await expect(saved(f)).not.toContainText('Downstream RCP');
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
  // The name 0.1.74 saved is dropped, and none is written.
  expect((await call('read-plan')).plan.savedDevices.every((row: any) => !('name' in row))).toBe(true);

  // 10.20.0.0/16 holds none of the saved devices' factory addresses.
  const range = f.locator('[data-role="scan-bar"] button.hc-dropdown').first();
  await range.click();
  await f.locator('.hc-dropdown-menu').getByRole('option', { name: '10.20.0.0/16' }).click();
  await f.locator('[data-role="scan-bar"] [data-action="scan"]').click();
  await expect(f.locator('[data-role="scan-label"]')).toContainText('Discovery complete');
  const order = await sheet(f).locator('tr.hc-device-found').evaluateAll(list => list.map(row => (row as HTMLElement).dataset.deviceSaved ?? 'sweep'));
  // In the order they were saved. Spare RIO was saved first but didn't answer, so it stays in Saved devices
  // and isn't on the sheet (Nov 21, 2026).
  expect(order.slice(0, 2)).toEqual([RIO, LEAF]);
  await expect(savedRow(f, LEAF).locator('.hc-found-tag')).toHaveText('Found');
  await expect(savedRow(f, 'CY-RIO-1-99')).toHaveCount(0);
  await open_.click();
  await expect(saved(f).locator('tr[data-saved-device="CY-RIO-1-99"] [data-saved-check]')).toHaveText('Didn’t answer');
  await expect(saved(f).locator('tr[data-saved-device="' + LEAF + '"] [data-saved-check]')).toHaveText('Found · add it on the sheet');
  await saved(f).press('Escape');
  // Added from its saved row, it takes the name the device has now, not one from the saved list.
  const reported = (await savedRow(f, LEAF).locator('td').nth(1).innerText()).trim();
  await savedRow(f, LEAF).getByRole('button', { name: 'Add ' + reported }).click();
  await expect(deviceRow(f, LEAF).locator('[data-device-cell="' + LEAF + ':name"]')).toHaveValue(reported);
  await expect(savedRow(f, LEAF)).toHaveCount(0);

  // Forget takes a device off the saved list only.
  await open_.click();
  await saved(f).getByRole('button', { name: 'Forget CY-RIO-1-99' }).click();
  await expect(saved(f).locator('tr[data-saved-device="CY-RIO-1-99"]')).toHaveCount(0);
  await expect(savedRow(f, 'CY-RIO-1-99')).toHaveCount(0);
  await saved(f).press('Escape');
  await settled(request);
  expect((await call('read-plan')).plan.savedDevices.map((row: any) => row.serial).sort()).toEqual(['CY-RCP-1-20', 'CY-RCP-1-30', 'CY-RIO-1-10']);
});

test('Saved devices says Checking the moment Discover is pressed, and the sheet lists one once it answers', async ({ page, request }) => {
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
  await f.getByRole('button', { name: /^Saved devices/ }).click();
  // Saved devices says so; the sheet lists it only once it answers.
  await expect(saved(f).locator('tr[data-saved-device="' + LEAF + '"] [data-saved-check]')).toHaveText('Checking…');
  await expect(savedRow(f, LEAF)).toHaveCount(0);
  await request.post('/__simulate', { data: { pauseState: false } });
  await expect(savedRow(f, LEAF).locator('.hc-found-tag')).toHaveText('Found');
});
