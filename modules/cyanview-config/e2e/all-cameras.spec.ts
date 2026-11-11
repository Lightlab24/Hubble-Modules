import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const matrix = (f: FrameLocator) => f.locator('[data-controller="__all-cameras__"]');
const config = (f: FrameLocator, id: string) => f.locator('[data-controller="' + id + '"]');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const named = (scope: Locator, name: string) => scope.locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const row = (f: FrameLocator, name: string) => named(matrix(f), name);
const cell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20', LEAF = 'CY-RCP-1-30', TRUCK = 'CY-RCP-1-40', CART = 'CY-RCP-1-50';
const on = (id: string) => 'remi:' + id;
const circle = (r: Locator, id: string) => cell(r, on(id)).locator('[role="checkbox"]');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const line = (f: FrameLocator, id: string) => panel(f).locator('[data-pending-line="' + id + '"]');
const group = (f: FrameLocator, name: string) => panel(f).locator('.hc-pending-camera:has(strong:text-is("' + name + '"))');
const pendingCount = (f: FrameLocator) => f.locator('.hc-panel:not([hidden]) [data-pending-sends-count]');
// The middle of a circle's cell is the circle, so select the cell from its corner.
const select = (r: Locator, column: string) => cell(r, column).click({ position: { x: 4, y: 4 } });

const gridOf = (r: Locator) => r.locator('xpath=ancestor::table[1]');

async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}) {
  await request.post('/__reset', { data: { sample: false, remi: true, ...data } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await showMatrix(f);
  // The page saves once or twice as it opens; a test that rewrites the saved plan waits for those.
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  return f;
}
async function showMatrix(f: FrameLocator) {
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await expect(matrix(f).locator('[role="checkbox"]').first()).toBeVisible();
}
async function showSetup(f: FrameLocator) {
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
}
// The sheets of each controller, as a view of the REMI Matrix tab.
async function showConfig(f: FrameLocator) {
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click();
  const expand = f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true });
  if (await expand.isVisible()) await expand.click();
}
async function choose(f: FrameLocator, r: Locator, column: string, label: string) {
  await cell(r, column).click();
  await gridOf(r).press('Enter');
  await f.getByRole('dialog').getByRole('option', { name: label, exact: true }).click();
}
async function setMaster(f: FrameLocator, name: string, label: string) {
  await showMatrix(f);
  await choose(f, row(f, name), 'remiMaster', label);
}
async function setSource(f: FrameLocator, name: string, label: string) {
  await showSetup(f);
  await choose(f, named(setup(f), name), 'source', label);
}
async function showPending(f: FrameLocator) {
  if (await panel(f).isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(panel(f)).toBeVisible();
}
async function sendAll(f: FrameLocator) {
  await showPending(f);
  await panel(f).locator('[data-action="send-all-pending"]').click();
}
// The count box adds a row at the end, named for its number. The Add camera menu it replaced also
// chose a model, so a test that wants one picks it.
async function addCamera(f: FrameLocator, scope: Locator, model = 'Venice-IP') {
  const rows = scope.locator('tbody tr[data-id]'), before = await rows.count();
  await scope.locator('[data-count-step="1"]').click();
  await expect(rows).toHaveCount(before + 1);
  const name = await cell(rows.last(), 'name').locator('input').inputValue();
  if (!(await cell(named(scope, name), 'model').innerText()).includes(model)) await choose(f, named(scope, name), 'model', model);
  await expect(cell(named(scope, name), 'model')).toContainText(model);
  return name;
}
const settle = (f: FrameLocator) => expect(panel(f)).toContainText('Nothing is waiting to send');
type Device = { config: { Camera: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
async function fleet(request: APIRequestContext) {
  return (await (await request.get('/__inspect')).json()).fleet as Device[];
}
const names = (device: Device) => Object.values(device.config.Camera).map(camera => camera.Name);
const realNames = (device: Device) => Object.values(device.config.Camera).filter(camera => camera.Model !== 'Cyan - Imported').map(camera => camera.Name);
const rpcOf = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;

test('Camera Configuration is one list of every camera with its settings and Source', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await showSetup(f);
  await expect(f.locator('[data-tab="setup"]')).toContainText('Camera Configuration');
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(2);
  const headings = await setup(f).locator('thead').allInnerTexts().then(text => text.join(' '));
  for (const label of ['Camera name', 'Camera model', 'Username', 'Password', 'Source', 'Lens model']) expect(headings).toContain(label);
  expect(headings).not.toContain('Master RCP');
  await expect(cell(named(setup(f), 'Wide'), 'source')).toHaveText('Stage RIO');
  await expect(cell(named(setup(f), 'Jib'), 'source')).toHaveText('Master RCP');
  await expect(cell(named(setup(f), 'Jib'), 'ip').locator('input')).toHaveValue('10.20.20.7');
  await expect(named(setup(f), 'Jib').locator('[data-action="stage-remove"]')).toBeVisible();
  // The sheets of each controller are no longer a tab of their own.
  await expect(f.locator('[data-tab="cameras"]')).toHaveCount(0);
  const jib = named(setup(f), 'Jib');
  await cell(jib, 'source').click();
  await gridOf(jib).press('Enter');
  for (const name of ['Stage RIO', 'Master RCP', 'Downstream RCP']) await expect(f.getByRole('dialog').getByRole('option', { name, exact: true })).toBeVisible();
  // A camera already on a controller can move, but it can't go back to being nowhere.
  await expect(f.getByRole('dialog').getByRole('option', { name: 'Not assigned', exact: true })).toHaveCount(0);
});

test('a new camera needs no controller, and choosing its Source then Send creates it there', async ({ page, request }) => {
  const f = await open(page, request);
  await showSetup(f);
  const before = (await fleet(request)).map(device => device.actions.length);
  const newName = await addCamera(f, setup(f));
  const added = named(setup(f), newName);
  await expect(cell(added, 'source')).toHaveText('Choose source');
  await expect(cell(added, 'sync')).toHaveText('Not assigned');
  await expect(f.locator('[data-role="setup-summary"]')).toContainText('1 not assigned');
  await cell(added, 'ip').locator('input').fill('10.20.20.42');
  await cell(added, 'ip').locator('input').press('Enter');
  await showPending(f);
  await settle(f);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await showSetup(f);
  await expect(cell(named(setup(f), newName), 'ip').locator('input')).toHaveValue('10.20.20.42');
  await expect(cell(named(setup(f), newName), 'sync')).toHaveText('Not assigned');
  // It isn't on anything yet, so the matrix doesn't list it and the worker never sees it.
  await showMatrix(f);
  await expect(row(f, newName)).toHaveCount(0);
  expect((await rpcOf(request)('read-plan')).plan.cameras.map((camera: { name: string }) => camera.name)).toEqual(['Wide']);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);

  await setSource(f, newName, 'Downstream RCP');
  await expect(line(f, 'new')).toContainText('Created on Downstream RCP');
  await sendAll(f);
  await settle(f);
  await expect(cell(named(setup(f), newName), 'sync')).toHaveText('Verified');
  const made = Object.values((await fleet(request))[2]!.config.Camera).find(camera => camera.Name === newName)!;
  expect(made.IP).toBe('10.20.20.42');
  await showMatrix(f);
  await expect(cell(row(f, newName), 'source')).toHaveText('Downstream RCP');
});

test('REMI Matrix can switch to the sheets of each controller and remembers which', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await expect(matrix(f)).toBeVisible();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click();
  await expect(config(f, MASTER)).toBeVisible();
  await expect(matrix(f)).toHaveCount(0);
  await expect(f.locator('[data-tab="assignment"]')).toHaveAttribute('aria-selected', 'true');
  await showSetup(f);
  await expect(config(f, MASTER)).toBeHidden();
  await f.locator('[data-tab="assignment"]').click();
  await expect(config(f, MASTER)).toBeVisible();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]')).toHaveAttribute('aria-pressed', 'true');
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await expect(matrix(f).locator('tbody tr[data-id]')).toHaveCount(2);
});

test('a page saved on the old Camera Configuration opens on the new one', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
  plan.uiState.privateContent.tab = 'cameras';
  delete plan.uiState.privateContent.remiView;
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await expect(f.locator('[data-tab="setup"]')).toHaveAttribute('aria-selected', 'true');
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(1);
  await f.locator('[data-tab="assignment"]').click();
  await expect(matrix(f).locator('tbody tr[data-id]')).toHaveCount(1);
});

test('the matrix lists every camera once with its source, master and a circle per RCP', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await expect(matrix(f).locator('tbody tr[data-id]')).toHaveCount(2);
  await expect(f.locator('[data-tab="assignment"]')).toContainText('REMI Matrix');
  const headings = () => matrix(f).locator('thead').allInnerTexts().then(text => text.join(' '));
  for (const label of ['Camera name', 'Source', 'Master RCP', 'REMI to', 'Downstream RCP']) expect(await headings()).toContain(label);
  for (const label of ['Username', 'Lens model']) expect(await headings()).not.toContain(label);
  // A RIO is somewhere a camera starts, not somewhere it goes.
  await expect(cell(row(f, 'Wide'), on(RIO))).toHaveCount(0);
  await expect(cell(row(f, 'Wide'), 'source')).toHaveText('Stage RIO');
  await expect(cell(row(f, 'Wide'), 'remiMaster')).toHaveText('None');
  await expect(cell(row(f, 'Jib'), on(MASTER))).toHaveText('Source');
  expect(await circle(row(f, 'Wide'), MASTER).evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('50%');
  // The Source is read here and set on Camera Configuration.
  await cell(row(f, 'Jib'), 'source').click();
  await f.getByRole('grid').press('Enter');
  await expect(f.getByRole('dialog').getByRole('option')).toHaveCount(0);
  // Its own controller isn't offered as its master.
  await cell(row(f, 'Jib'), 'remiMaster').click();
  await f.getByRole('grid').press('Enter');
  await expect(f.getByRole('dialog').getByRole('option', { name: 'Master RCP', exact: true })).toHaveCount(0);
  await expect(f.getByRole('dialog').getByRole('option', { name: 'Downstream RCP', exact: true })).toBeVisible();
  await f.getByRole('grid').press('Escape');

  await showConfig(f);
  const jib = named(config(f, MASTER), 'Jib');
  await expect(cell(jib, 'remiMaster')).toHaveText('None');
  await expect(jib.locator('[data-action="stage-remove"]')).toBeVisible();
  expect(await jib.locator('[data-field="controlEnabled"] [role="checkbox"]').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('3px');
});

test('a master set on the matrix routes the camera through it to the clicked RCPs', async ({ page, request }) => {
  const f = await open(page, request, { direct: true, extra: true });
  const before = (await fleet(request)).map(device => device.actions.length);
  await setMaster(f, 'Jib', 'Downstream RCP');
  const jib = row(f, 'Jib');
  await expect(cell(jib, 'remiMaster')).toHaveClass(/hc-changed/);
  await expect(cell(jib, 'remiMaster')).toHaveText('Downstream RCP');
  await expect(cell(jib, on(LEAF))).toHaveText('Master');
  await circle(jib, TRUCK).click();
  await expect(circle(jib, TRUCK)).toBeChecked();
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
  await showPending(f);
  await expect(line(f, 'master')).toContainText('None → Downstream RCP');
  await expect(line(f, on(TRUCK))).toContainText('Off → On');
  await expect(panel(f)).toContainText('Master RCP → Downstream RCP → Truck RCP');
  await sendAll(f);
  await settle(f);
  await expect(cell(jib, 'sync')).toHaveText('Verified');
  const after = await fleet(request);
  expect(names(after[2]!)).toEqual(['Jib']);
  expect(names(after[3]!)).toEqual(['Jib']);
  expect(names(after[4]!)).toEqual([]);

  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await showMatrix(f);
  await expect(cell(row(f, 'Jib'), on(LEAF))).toHaveText('Master');
  await expect(circle(row(f, 'Jib'), TRUCK)).toBeChecked();
  await expect(cell(row(f, 'Jib'), 'remiMaster')).not.toHaveClass(/hc-changed/);
  // A master with nothing after it is still that camera's master.
  await circle(row(f, 'Jib'), TRUCK).click();
  await sendAll(f);
  await settle(f);
  await expect(cell(row(f, 'Jib'), on(LEAF))).toHaveText('Master');
  expect(names((await fleet(request))[3]!)).toEqual([]);
});

test('a RIO camera goes RIO, master, then each RCP, and with no master straight from the RIO', async ({ page, request }) => {
  const f = await open(page, request, { extra: true });
  await setMaster(f, 'Wide', 'Master RCP');
  const wide = row(f, 'Wide');
  await circle(wide, LEAF).click();
  await circle(wide, CART).click();
  await showPending(f);
  await expect(panel(f)).toContainText('Stage RIO → Master RCP → Downstream RCP, Cart RCP');
  await sendAll(f);
  await settle(f);
  let after = await fleet(request);
  expect(names(after[0]!)).toEqual(['Wide']);
  for (const index of [1, 2, 4]) expect(names(after[index]!)).toEqual(['Wide']);
  expect(names(after[3]!)).toEqual([]);
  await showConfig(f);
  await expect(config(f, LEAF).locator('[data-remi-model-source]')).toHaveText('Stage RIO');

  await setMaster(f, 'Wide', 'None');
  await expect(circle(row(f, 'Wide'), MASTER)).not.toBeChecked();
  await expect(line(f, 'master')).toContainText('Master RCP → None');
  await sendAll(f);
  await settle(f);
  after = await fleet(request);
  expect(names(after[1]!)).toEqual([]);
  expect(names(after[2]!)).toEqual(['Wide']);
  expect(names(after[4]!)).toEqual(['Wide']);
});

test('the bin marks a camera for deleting, and Send deletes it with its copies', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await circle(row(f, 'Jib'), LEAF).click();
  await sendAll(f);
  await settle(f);
  const before = (await fleet(request)).map(device => device.actions.length);

  await showConfig(f);
  const jib = named(config(f, MASTER), 'Jib');
  await jib.locator('[data-action="stage-remove"]').click();
  await expect(jib).toHaveClass(/hc-remove-staged/);
  await expect(cell(jib, 'sync')).toHaveText('Delete');
  await expect(line(f, 'delete')).toContainText('Deleted from Master RCP');
  await expect(line(f, 'delete')).toContainText('REMI copies on Downstream RCP come off first');
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
  // The same button keeps it.
  await expect(jib.locator('[data-action="stage-remove"]')).toHaveAttribute('aria-label', 'Keep camera 7');
  await jib.locator('[data-action="stage-remove"]').click();
  await expect(jib).not.toHaveClass(/hc-remove-staged/);
  await expect(line(f, 'delete')).toHaveCount(0);

  // The matrix's Delete button and right-click do the same.
  await showMatrix(f);
  await cell(row(f, 'Jib'), 'name').click();
  await matrix(f).locator('[data-action="delete-controller"]').click();
  await expect(row(f, 'Jib')).toHaveClass(/hc-remove-staged/);
  await sendAll(f);
  await settle(f);
  await expect(row(f, 'Jib')).toHaveCount(0);
  const after = await fleet(request);
  expect(names(after[1]!)).toEqual([]);
  expect(names(after[2]!)).toEqual([]);
});

test('Clear from view forgets a camera here only, and a read brings it back to clear or delete again', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await circle(row(f, 'Jib'), LEAF).click();
  await sendAll(f);
  await settle(f);
  const before = (await fleet(request)).map(device => device.actions.length);
  await showSetup(f);
  const jib = named(setup(f), 'Jib');
  await jib.locator('[data-action="clear-from-view"]').click();
  await expect(jib).toHaveCount(0);
  // Its copy lives in its row, so it doesn't turn up as a row of its own.
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(1);
  await expect(f.locator('[data-role="toast"]')).toContainText('cleared from view');
  await settle(f);
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
  expect(names((await fleet(request))[1]!)).toEqual(['Jib']);

  // Undo restores it, copy included.
  await cell(named(setup(f), 'Wide'), 'name').click();
  await gridOf(named(setup(f), 'Wide')).press('Meta+z');
  await expect(named(setup(f), 'Jib')).toHaveCount(1);
  await showMatrix(f);
  await expect(circle(row(f, 'Jib'), LEAF)).toBeChecked();

  await showSetup(f);
  await named(setup(f), 'Jib').locator('[data-action="clear-from-view"]').click();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await showSetup(f);
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect.poll(async () => (await rpcOf(request)('read-plan')).plan.cameras.map((camera: { name: string }) => camera.name)).toEqual(['Wide']);

  // The controller still has it, so a read brings it back to delete for real.
  await f.locator('[data-action="refresh-all"]').click();
  await expect(named(setup(f), 'Jib')).toHaveCount(1);
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(2);
  await named(setup(f), 'Jib').locator('[data-action="stage-remove"]').click();
  await expect(line(f, 'delete')).toBeVisible();
  await sendAll(f);
  await settle(f);
  expect(names((await fleet(request))[1]!)).toEqual([]);
  expect(names((await fleet(request))[2]!)).toEqual([]);
});

test('several selected cameras clear together, and a copy with no known source can be cleared', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
  plan.cameras.push({ id: 'old-copy', device: MASTER, elementKey: 'copy', number: '5', name: 'Old copy', model: 'Cyan - Imported', modelLabel: 'Cyan - Imported', dirty: [], isNew: false, result: 'In sync' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await showSetup(f);
  const copy = named(setup(f), 'Old copy'), clear = setup(f).locator('[data-action="clear-selected"]');
  await expect(clear).toBeDisabled();
  await copy.locator('[data-action="clear-from-view"]').click();
  await expect(copy).toHaveCount(0);
  await cell(named(setup(f), 'Wide'), 'name').click();
  await gridOf(named(setup(f), 'Wide')).press('Shift+ArrowDown');
  await expect(clear).toHaveText('Clear 2 from view');
  await clear.click();
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(0);
  expect((await fleet(request)).map(names)).toEqual([['Wide'], ['Jib'], []]);
});

test('Refresh all clears everything waiting to be sent and shows what the controllers have', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  const before = (await fleet(request)).map(device => device.actions.length);
  await circle(row(f, 'Jib'), LEAF).click();
  await setMaster(f, 'Wide', 'Master RCP');
  await showSetup(f);
  await named(setup(f), 'Jib').locator('[data-action="stage-remove"]').click();
  await cell(named(setup(f), 'Wide'), 'name').locator('input').fill('Renamed here');
  await cell(named(setup(f), 'Wide'), 'name').locator('input').press('Enter');
  await showConfig(f);
  const newName = await addCamera(f, config(f, MASTER));
  await showSetup(f);
  await showPending(f);
  await expect(panel(f).locator('.hc-pending-item').first()).toBeVisible();
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);

  await f.locator('[data-action="refresh-all"]').click();
  await settle(f);
  await expect(f.locator('[data-role="toast"]')).toContainText('cleared');
  await expect(named(setup(f), 'Jib')).not.toHaveClass(/hc-remove-staged/);
  await expect(named(setup(f), 'Wide')).toHaveCount(1);
  await expect(cell(named(setup(f), 'Wide'), 'name')).not.toHaveClass(/hc-changed/);
  // What was typed for a camera that never reached a controller isn't thrown away.
  await expect(cell(named(setup(f), newName), 'sync')).toHaveText('Not assigned');
  await showMatrix(f);
  await expect(circle(row(f, 'Jib'), LEAF)).not.toBeChecked();
  await expect(cell(row(f, 'Wide'), 'remiMaster')).toHaveText('None');
  expect((await fleet(request)).map(device => device.actions.length)).toEqual(before);
  await expect(f.locator('.hc-global-foot')).toContainText('All changes verified');
});

test('a controller saved on a LAN address moves to its base address when the page opens', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
  const device = plan.devices[0];
  expect(device.alias).toMatch(/^10\.20\./);
  device.address = device.alias;
  await rpc('save-plan', { revision, plan });
  await page.reload();
  // Nothing is pressed.
  await expect.poll(async () => (await rpc('read-plan')).plan.devices[0].address, { timeout: 10000 }).toBe(device.base);
  expect((await fleet(request)).map(item => item.actions.length)).toEqual([0, 0, 0]);
});

test('an unfinished REMI refresh is listed in Pending sends and can be dismissed', async ({ page, request }) => {
  const f = await open(page, request);
  await circle(row(f, 'Wide'), MASTER).click();
  await sendAll(f);
  await settle(f);
  // Master RCP drops off the network, then the camera it has a copy of is renamed on its RIO.
  const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
  Object.assign(plan.devices.find((device: { id: string }) => device.id === MASTER), { base: '10.99.99.99', alias: '', address: '10.99.99.99' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await showSetup(f);
  const name = cell(named(setup(f), 'Wide'), 'name').locator('input');
  await name.fill('Wide two');
  await name.press('Enter');
  await sendAll(f);
  const job = panel(f).locator('[data-pending-job]');
  await expect(job).toContainText('Unfinished REMI refresh');
  await expect(job).toContainText('Wide two');
  await job.getByRole('button', { name: /Dismiss/ }).click();
  await expect(job).toHaveCount(0);
  await expect(f.locator('[data-role="toast"]')).toContainText('dismissed');
  expect((await rpc('remi-send', { operation: 'jobs' })).jobs).toEqual([]);
});

test('REMI changes staged on a controller are listed in Pending sends, and Refresh all clears them', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const seed = async () => {
    const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
    plan.uiState.privateContent.remiDrafts = { [LEAF]: { drafts: [{ id: 'remove:gone', kind: 'remove', key: 'gone', enable: false, selector: 's', connection: 'c', label: 'FX3 16-35' }], overrides: {} } };
    await rpc('save-plan', { revision, plan });
    await page.reload();
    await showSetup(f);
    await showPending(f);
  };
  await seed();
  const stale = panel(f).locator('[data-pending-remi-line="remove:gone"]');
  await expect(stale).toContainText('FX3 16-35');
  await expect(pendingCount(f)).toHaveText('1');
  await stale.getByRole('button').click();
  await settle(f);
  await seed();
  await f.locator('[data-action="refresh-all"]').click();
  await settle(f);
  await expect(f.locator('.hc-global-foot')).toContainText('All changes verified');
  await page.reload();
  await showSetup(f);
  await showPending(f);
  await settle(f);
});

test('a large delete goes out over one socket per controller', async ({ page, request }) => {
  const f = await open(page, request);
  const rpc = rpcOf(request);
  await showSetup(f);
  for (let index = 0; index < 8; index++) await addCamera(f, setup(f), 'Alpha-USB');
  for (let index = 0; index < 8; index++) await choose(f, setup(f).locator('tbody tr[data-id]:has(input[data-field="name"][value^="Camera "])').nth(index), 'source', 'Master RCP');
  await sendAll(f);
  await settle(f);
  expect(names((await fleet(request))[1]!)).toHaveLength(8);
  const rows = setup(f).locator('tbody tr[data-id]:has(input[data-field="name"][value^="Camera "])');
  for (let index = 0; index < 8; index++) await rows.nth(index).locator('[data-action="stage-remove"]').click();
  await expect(line(f, 'delete')).toHaveCount(8);
  const inspect = async () => (await (await request.get('/__inspect')).json()) as { opened: number[] };
  const opened = (await inspect()).opened;
  await sendAll(f);
  await settle(f);
  await expect(rows).toHaveCount(0);
  expect(names((await fleet(request))[1]!)).toEqual([]);
  const after = (await inspect()).opened;
  expect(after[1]! - opened[1]!).toBe(1);
  expect((await rpc('read-plan')).plan.cameras.map((camera: { name: string }) => camera.name)).toEqual(['Wide']);
});

test('deleting a copy on Camera Configuration clears its circle and waits for Send', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await circle(row(f, 'Jib'), LEAF).click();
  await sendAll(f);
  await settle(f);
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await showConfig(f);
  const copy = config(f, LEAF).locator('tbody tr[data-id]').first();
  await cell(copy, 'name').click({ button: 'right' });
  await f.getByRole('menuitem', { name: 'Remove REMI copy', exact: true }).click();
  await expect(copy).toHaveClass(/hc-remove-staged/);
  await expect(line(f, on(LEAF))).toContainText('On → Off');
  expect(names((await fleet(request))[2]!)).toEqual(['Jib']);
  await sendAll(f);
  await settle(f);
  await expect(config(f, LEAF).locator('tbody tr[data-id]')).toHaveCount(0);
  expect(names((await fleet(request))[2]!)).toEqual([]);
});

test('each change can be cancelled, and each camera sent on its own', async ({ page, request }) => {
  const f = await open(page, request, { direct: true, extra: true });
  const wide = row(f, 'Wide'), jib = row(f, 'Jib');
  await circle(jib, LEAF).click();
  await circle(jib, TRUCK).click();
  await circle(wide, MASTER).click();
  await showPending(f);
  await expect(pendingCount(f)).toHaveText('3');
  await line(f, on(TRUCK)).getByRole('button').click();
  await expect(circle(jib, TRUCK)).not.toBeChecked();
  await expect(cell(jib, on(TRUCK))).not.toHaveClass(/hc-changed/);
  await expect(circle(jib, LEAF)).toBeChecked();
  await group(f, '7 · Jib').getByRole('button', { name: 'Send all changes' }).click();
  await expect(cell(jib, 'sync')).toHaveText('Verified');
  await expect(cell(wide, 'sync')).toHaveText('Pending');
  await group(f, '1 · Wide').getByRole('button', { name: 'Cancel all changes' }).click();
  await expect(circle(wide, MASTER)).not.toBeChecked();
  await settle(f);
  // Pending sends is the same list on Camera Configuration.
  await circle(wide, LEAF).click();
  await showConfig(f);
  await expect(panel(f)).toBeVisible();
  await expect(group(f, '1 · Wide')).toBeVisible();
  await panel(f).locator('[data-action="cancel-all-pending"]').click();
  await settle(f);
});

test('changing a Source moves a camera between controllers and carries its settings', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await setMaster(f, 'Jib', 'Downstream RCP');
  await sendAll(f);
  await settle(f);
  await setSource(f, 'Jib', 'Stage RIO');
  await expect(cell(named(setup(f), 'Jib'), 'source')).toHaveClass(/hc-changed/);
  await expect(line(f, 'source')).toContainText('Master RCP → Stage RIO');
  await expect(line(f, 'source')).toContainText('then deleted from Master RCP');
  await sendAll(f);
  await settle(f);
  const after = await fleet(request);
  const moved = Object.values(after[0]!.config.Camera).find(camera => camera.Name === 'Jib')!;
  expect([moved.Number, moved.IP, moved.Port, moved.Model]).toEqual(['7', '10.20.20.7', '80', 'Sony - Venice-IP']);
  expect(realNames(after[1]!)).toEqual([]);
  expect(names(after[2]!)).toEqual(['Jib']);
  await showMatrix(f);
  await expect(cell(row(f, 'Jib'), 'source')).toHaveText('Stage RIO');
  await expect(cell(row(f, 'Jib'), on(LEAF))).toHaveText('Master');
});

test('a move carries every setting: login, lens, lens axis, connection and camera control', async ({ page, request }) => {
  const f = await open(page, request);
  await showConfig(f);
  const sheet = config(f, MASTER);
  const newName = await addCamera(f, sheet);
  const added = named(sheet, newName);
  const type = async (column: string, value: string) => {
    const input = cell(added, column).locator('input').first();
    await input.fill(value);
    await input.press('Enter');
  };
  await type('ip', '10.20.20.42');
  await type('port', '8080');
  await type('login', 'operator');
  await type('password', 'fixture-pass');
  await choose(f, added, 'lens', 'Tilta - Nucleus-M');
  // A controller only lists its lens connections for a camera it already has.
  await sendAll(f);
  await expect(cell(added, 'sync')).toHaveText('Verified');
  await choose(f, added, 'connection', 'RIO-1-10 : 2');
  await sheet.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await added.locator('[data-lens-axis="iris"] [role="checkbox"]').click();
  for (const [column, value] of [['irisMotor', '7'], ['irisMin', '1.6'], ['irisMax', '22']] as const) await type(column, value);
  await sendAll(f);
  await expect(cell(added, 'sync')).toHaveText('Verified');
  await added.locator('[data-field="controlEnabled"] [role="checkbox"]').click();
  await expect(added.locator('[data-field="controlEnabled"] [role="checkbox"]')).toBeChecked();
  await setSource(f, newName, 'Downstream RCP');
  await sendAll(f);
  await settle(f);
  const after = await fleet(request);
  expect(names(after[1]!)).toEqual([]);
  const moved = Object.values(after[2]!.config.Camera).find(camera => camera.Name === newName)!;
  expect([moved.IP, moved.Port, moved.Login, moved.Password, moved.LensModel, moved.LensParams]).toEqual(['10.20.20.42', '8080', 'operator', 'fixture-pass', 'Tilta - Nucleus-M', '7:I:1.6:22']);
  expect(moved.LensInterface.port).toBe('2');
  await expect(named(setup(f), newName).locator('[data-field="controlEnabled"] [role="checkbox"]')).toBeChecked();
});

test('click, keyboard, drag and paste all work on the circles', async ({ page, request }) => {
  const f = await open(page, request, { direct: true, extra: true });
  const wide = row(f, 'Wide'), jib = row(f, 'Jib');
  await select(wide, on(LEAF));
  await f.getByRole('grid').press(' ');
  await expect(circle(wide, LEAF)).toBeChecked();
  await f.getByRole('grid').press('Delete');
  await expect(circle(wide, LEAF)).not.toBeChecked();
  await circle(wide, LEAF).click();
  await select(wide, on(LEAF));
  const handle = (await f.locator('.hubble-spreadsheet-fill-handle:visible').boundingBox())!, target = (await cell(jib, on(LEAF)).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(circle(jib, LEAF)).toBeChecked();
  await expect(cell(jib, on(LEAF))).toHaveClass(/hc-changed/);
  if (await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).then(() => true, () => false)) {
    await select(wide, on(LEAF));
    await f.getByRole('grid').press('Meta+c');
    await select(jib, on(TRUCK));
    await f.getByRole('grid').press('Meta+v');
    await expect(circle(jib, TRUCK)).toBeChecked();
  }
});

test('an edit shows at once and a second can follow while the first save is held', async ({ page, request }) => {
  const f = await open(page, request, { extra: true });
  const wide = row(f, 'Wide');
  await request.post('/__simulate', { data: { holdPlanWrites: true } });
  await circle(wide, LEAF).click();
  await expect(circle(wide, LEAF)).toBeChecked();
  await circle(wide, TRUCK).click();
  await expect(circle(wide, TRUCK)).toBeChecked();
  await showConfig(f);
  await named(config(f, RIO), 'Wide').locator('[data-action="stage-remove"]').click();
  await expect(named(config(f, RIO), 'Wide')).toHaveClass(/hc-remove-staged/);
  await request.post('/__simulate', { data: { releasePlanWrites: true } });
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await showMatrix(f);
  await expect(circle(row(f, 'Wide'), LEAF)).toBeChecked();
  await expect(row(f, 'Wide')).toHaveClass(/hc-remove-staged/);
  await showPending(f);
  await expect(line(f, 'delete')).toBeVisible();
});

test('undo takes back a circle, a master and a delete', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  const jib = row(f, 'Jib');
  await circle(jib, LEAF).click();
  await select(jib, on(LEAF));
  await f.getByRole('grid').press('Meta+z');
  await expect(circle(jib, LEAF)).not.toBeChecked();
  await setMaster(f, 'Jib', 'Downstream RCP');
  await showConfig(f);
  const configured = named(config(f, MASTER), 'Jib');
  await expect(cell(configured, 'remiMaster')).toHaveText('Downstream RCP');
  await configured.locator('[data-action="stage-remove"]').click();
  await expect(configured).toHaveClass(/hc-remove-staged/);
  await cell(configured, 'number').click();
  const grid = gridOf(configured);
  await grid.press('Meta+z');
  await expect(configured).not.toHaveClass(/hc-remove-staged/);
  // Undo belongs to the view the edit was made on.
  await showMatrix(f);
  await cell(row(f, 'Jib'), 'name').click();
  await f.getByRole('grid').press('Meta+z');
  await expect(cell(row(f, 'Jib'), 'remiMaster')).toHaveText('None');
  await expect(pendingCount(f)).toBeHidden();
});

test('Auto send sends a circle at once, and a master, move or delete waits to be sent', async ({ page, request }) => {
  const f = await open(page, request, { direct: true, extra: true });
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await circle(row(f, 'Jib'), LEAF).click();
  await expect(cell(row(f, 'Jib'), 'sync')).toHaveText('Verified');
  expect(names((await fleet(request))[2]!)).toEqual(['Jib']);
  await setMaster(f, 'Jib', 'Truck RCP');
  await showPending(f);
  await expect(line(f, 'master')).toBeVisible();
  await showSetup(f);
  await named(setup(f), 'Jib').locator('[data-action="stage-remove"]').click();
  await expect(line(f, 'delete')).toBeVisible();
  const after = await fleet(request);
  expect(names(after[1]!)).toEqual(['Jib']);
  expect(names(after[2]!)).toEqual(['Jib']);
});

test('a setting edited on Camera Configuration is listed with its old value, after a reload too', async ({ page, request }) => {
  const f = await open(page, request);
  await showConfig(f);
  const newName = await addCamera(f, config(f, MASTER));
  await showSetup(f);
  const added = named(setup(f), newName);
  await showPending(f);
  await expect(line(f, 'new')).toContainText('Created on Master RCP');
  const ip = cell(added, 'ip').locator('input'), port = cell(added, 'port').locator('input');
  await ip.fill('10.20.20.7');
  await ip.press('Enter');
  await sendAll(f);
  await expect(cell(added, 'sync')).toHaveText('Verified');
  await ip.fill('10.20.20.42');
  await ip.press('Enter');
  await port.fill('8080');
  await port.press('Enter');
  await expect(line(f, 'setting:ip')).toContainText('10.20.20.7 → 10.20.20.42');
  await line(f, 'setting:ip').getByRole('button').click();
  await expect(ip).toHaveValue('10.20.20.7');
  await expect(cell(added, 'ip')).not.toHaveClass(/hc-changed/);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(line(f, 'setting:port')).toContainText('→ 8080');
  await line(f, 'setting:port').getByRole('button').click();
  await settle(f);
  await expect(cell(named(setup(f), newName), 'port').locator('input')).not.toHaveValue('8080');
});

test('an edit saved before this version can be cancelled, and the controller says what it was', async ({ page, request }) => {
  const f = await open(page, request);
  const rpc = rpcOf(request);
  const { revision, plan } = await rpc('read-plan');
  Object.assign(plan.cameras[0], { name: 'Staged long ago', dirty: ['name'], pending: true, result: 'Pending' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await showMatrix(f);
  await showPending(f);
  await expect(line(f, 'setting:name')).toContainText('Now Staged long ago');
  await line(f, 'setting:name').getByRole('button').click();
  await expect(row(f, 'Wide')).toHaveCount(1);
  await settle(f);
});

test('a camera added on Camera Configuration is listed as new, and its bin takes it away', async ({ page, request }) => {
  const f = await open(page, request);
  await showConfig(f);
  const sheet = config(f, MASTER);
  const newName = await addCamera(f, sheet);
  await named(sheet, newName).locator('[data-action="stage-remove"]').click();
  await expect(named(sheet, newName)).toHaveCount(0);
  await addCamera(f, sheet);
  await showPending(f);
  await line(f, 'new').getByRole('button').click();
  await expect(named(sheet, newName)).toHaveCount(0);
  expect((await fleet(request)).map(names)).toEqual([['Wide'], [], []]);
});

test('a move that cannot be created stays in the list and leaves the camera where it was', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await showConfig(f);
  const jib = named(config(f, MASTER), 'Jib');
  // Stage RIO already has a camera 1, so it will refuse this one.
  await cell(jib, 'number').locator('input').fill('1');
  await cell(jib, 'number').locator('input').press('Enter');
  await setSource(f, 'Jib', 'Stage RIO');
  await sendAll(f);
  await expect(panel(f).locator('.hc-pending-status[data-kind="failed"]')).toContainText('It is still on Master RCP');
  await expect(line(f, 'source')).toBeVisible();
  const after = await fleet(request);
  expect(names(after[1]!)).toEqual(['Jib']);
  expect(names(after[0]!)).toEqual(['Wide']);
});

test('a controller that cannot be reached leaves that camera pending and the others go', async ({ page, request }) => {
  const f = await open(page, request, { direct: true, extra: true });
  const rpc = rpcOf(request);
  const { revision, plan } = await rpc('read-plan');
  Object.assign(plan.devices.find((device: { id: string }) => device.id === TRUCK), { base: '10.99.99.99', alias: '', address: '10.99.99.99' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await showMatrix(f);
  await circle(row(f, 'Jib'), TRUCK).click();
  await circle(row(f, 'Wide'), MASTER).click();
  await sendAll(f);
  await expect(cell(row(f, 'Wide'), 'sync')).toHaveText('Verified');
  await expect(cell(row(f, 'Jib'), 'sync')).toHaveText('Error');
  await expect(line(f, on(TRUCK)).locator('.hc-pending-status')).toContainText('Cannot reach Truck RCP');
  expect(names((await fleet(request))[1]!).sort()).toEqual(['Jib', 'Wide']);
});

test('while one camera is sending, a queued one can still be cancelled', async ({ page, request }) => {
  const f = await open(page, request, { direct: true });
  await showConfig(f);
  const sheet = config(f, MASTER);
  const newName = await addCamera(f, sheet);
  await cell(named(sheet, newName), 'ip').locator('input').fill('10.20.20.8');
  await cell(named(sheet, newName), 'ip').locator('input').press('Enter');
  await sendAll(f);
  await settle(f);
  for (const name of ['Jib', newName]) await setSource(f, name, 'Stage RIO');
  await request.post('/__simulate', { data: { holdAction: 'new' } });
  await sendAll(f);
  const second = panel(f).locator('.hc-pending-camera:has(strong:has-text("' + newName + '"))');
  await expect(panel(f).locator('.hc-pending-status').first()).toHaveText('Sending…');
  await expect(panel(f).locator('.hc-pending-status').nth(1)).toHaveText('Queued');
  await second.getByRole('button', { name: 'Cancel all changes' }).click();
  await request.post('/__simulate', { data: { releaseReplies: true } });
  await settle(f);
  const after = await fleet(request);
  expect(realNames(after[1]!)).toEqual([newName]);
  expect(names(after[0]!).sort()).toEqual(['Jib', 'Wide']);
});

test('a camera that needs an offline controller says so and is left out of Send all', async ({ page, request }) => {
  const f = await open(page, request);
  await circle(row(f, 'Wide'), MASTER).click();
  await request.post('/__simulate', { data: { closeBroker: true } });
  await showPending(f);
  await expect(panel(f).locator('.hc-pending-status[data-kind="offline"]')).toContainText('offline', { timeout: 20000 });
  await expect(panel(f).locator('[data-action="send-all-pending"]')).toBeDisabled();
  await expect(group(f, '1 · Wide').getByRole('button', { name: 'Cancel all changes' })).toBeEnabled();
});

test('copies already sent straight from a RIO show as they are and survive another click', async ({ page, request }) => {
  const f = await open(page, request, { extra: true });
  for (const receiver of [MASTER, LEAF]) {
    const reply = await request.post('/__rpc', { data: { commandId: 'remi-send', value: { receiver, items: [{ id: 'wide', kind: 'camera', source: RIO, key: 'wide', enable: true }] } } });
    expect((await reply.json()).result.results[0].verified).toBe(true);
  }
  await f.locator('[data-action="refresh-all"]').click();
  const wide = row(f, 'Wide');
  await expect(circle(wide, MASTER)).toBeChecked();
  await expect(circle(wide, LEAF)).toBeChecked();
  await expect(cell(wide, 'remiMaster')).toHaveText('None');
  await circle(wide, TRUCK).click();
  await showPending(f);
  await expect(line(f, on(TRUCK))).toBeVisible();
  await expect(line(f, 'route')).toHaveCount(0);
  await expect(pendingCount(f)).toHaveText('1');
});

test('its layout and the open list come back after a reload', async ({ page, request }) => {
  const f = await open(page, request);
  await matrix(f).locator('[data-sort-field="source"]').click();
  await expect(matrix(f).locator('[data-sort-header="source"]')).toHaveAttribute('aria-sort', 'ascending');
  await matrix(f).locator('[data-action="camera-view"][data-view="columns"]').click();
  await expect(matrix(f).locator('tr[data-setting="source"]')).toBeVisible();
  await showPending(f);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(matrix(f).locator('tr[data-setting="source"]')).toBeVisible();
  await expect(panel(f)).toBeVisible();
  await matrix(f).locator('[data-action="camera-view"][data-view="rows"]').click();
  await expect(matrix(f).locator('[data-sort-header="source"]')).toHaveAttribute('aria-sort', 'ascending');
  await showConfig(f);
  await expect(config(f, RIO).locator('[data-field-header="source"]')).toHaveCount(0);
});

test('a copy whose source is not known yet says so, and deleting it still asks first', async ({ page, request }) => {
  const f = await open(page, request);
  const rpc = rpcOf(request);
  const { revision, plan } = await rpc('read-plan');
  plan.cameras.push({ id: 'old-copy', device: MASTER, elementKey: 'copy', number: '5', name: 'Old copy', model: 'Cyan - Imported', modelLabel: 'Cyan - Imported', dirty: [], isNew: false, result: 'In sync' });
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await showMatrix(f);
  const copy = row(f, 'Old copy');
  await expect(cell(copy, 'source')).toHaveText('Copy on Master RCP');
  await expect(circle(copy, LEAF)).toHaveCount(0);
  await cell(copy, 'name').click();
  await matrix(f).locator('[data-action="delete-controller"]').click();
  await expect(f.locator('[data-role="toast"]')).toContainText('Refresh the REMI assignment');
});
