import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

// Nov 21, 2026: "i can't just delete cameras, they have to be staged ... i need to be able to work on cameras
// when RCPs aren't connected". Every camera row has an eye, which clears it from the workspace only, and a bin,
// which clears it from its controller at once. Clear workspace clears every camera from the workspace.
const ui = (page: Page) => page.frameLocator('iframe');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const matrix = (f: FrameLocator) => f.locator('[data-controller="__all-cameras__"]');
const named = (scope: Locator, name: string) => scope.locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const cell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const eye = (r: Locator) => r.locator('[data-action="clear-workspace-row"]');
const bin = (r: Locator) => r.locator('[data-action="clear-rcp-row"]');
const outside = (f: FrameLocator) => f.locator('[data-role="outside"]');
const outsideRows = (f: FrameLocator) => outside(f).locator('tbody tr');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const toast = (f: FrameLocator) => f.locator('[data-role="toast"]');
const MASTER = 'CY-RCP-1-20';
type Device = { config: { Camera: Record<string, Record<string, any>> }; actions: Record<string, any>[] };
const fleet = async (request: APIRequestContext) => (await (await request.get('/__inspect')).json()).fleet as Device[];
const names = (device: Device) => Object.values(device.config.Camera).map(camera => camera.Name);
const written = async (request: APIRequestContext) => (await fleet(request)).map(device => device.actions.length);

async function open(page: Page, request: APIRequestContext, data: Record<string, unknown> = {}) {
  await request.post('/__reset', { data: { sample: false, remi: true, direct: true, ...data } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  await showSetup(f);
  return f;
}
async function showSetup(f: FrameLocator) {
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
}
async function showPending(f: FrameLocator) {
  if (await panel(f).isHidden()) await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(panel(f)).toBeVisible();
}
async function sendAll(f: FrameLocator) {
  await showPending(f);
  await panel(f).locator('[data-action="send-all-pending"]').click();
  await expect(panel(f)).toContainText('Nothing is waiting to send');
}
// Wide, on the RIO, gets a REMI copy on Master RCP.
async function copyWideToMaster(f: FrameLocator) {
  await f.locator('[data-tab="assignment"]').click();
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await named(matrix(f), 'Wide').locator('[data-column="remi:' + MASTER + '"] [role="checkbox"]').click();
  await sendAll(f);
  await showSetup(f);
}

test('the eye clears a camera from the workspace with its controller off, sends nothing, and ⌘Z puts it back', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(named(setup(f), 'Jib')).toHaveCount(1);
  await expect(eye(named(setup(f), 'Jib'))).toHaveAttribute('data-tip', /Nothing on Master RCP changes/);
  await expect(bin(named(setup(f), 'Jib'))).toHaveAttribute('data-tip', 'Clear camera 7 from Master RCP. It is deleted there, with its REMI copies.');
  await request.post('/__simulate', { data: { power: { device: 1, on: false } } });
  const before = await written(request);
  await eye(named(setup(f), 'Jib')).click();
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect(toast(f)).toHaveText('Camera 7 cleared from the workspace. Nothing on Master RCP changed · ⌘Z puts it back');
  // Nothing is staged or sent.
  await showPending(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  expect(await written(request)).toEqual(before);
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  await page.reload();
  await showSetup(f);
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect(named(setup(f), 'Wide')).toHaveCount(1);

  // ⌘Z works from the sheet it was cleared on, while the page is open.
  await eye(named(setup(f), 'Wide')).click();
  await expect(named(setup(f), 'Wide')).toHaveCount(0);
  await expect(setup(f).locator('[data-action="clear-workspace"]')).toBeDisabled();
  await setup(f).locator('table[role="grid"]').focus();
  await page.keyboard.press('Meta+z');
  await expect(named(setup(f), 'Wide')).toHaveCount(1);
  await page.keyboard.press('Meta+Shift+z');
  await expect(named(setup(f), 'Wide')).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(named(setup(f), 'Wide')).toHaveCount(1);
  expect(await written(request)).toEqual(before);
});

test('Clear workspace empties Camera Configuration at once, and Refresh all lists what the controllers still have apart', async ({ page, request }) => {
  const f = await open(page, request);
  await copyWideToMaster(f);
  const before = await written(request);
  const clear = setup(f).locator('[data-action="clear-workspace"]');
  await expect(clear).toBeEnabled();
  await clear.click();
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(0);
  await expect(toast(f)).toHaveText('2 cameras cleared from the workspace. Nothing on the RCPs changed · ⌘Z puts them back');
  await expect(clear).toBeDisabled();
  await expect(f.locator('[data-tab="setup"] .hc-tab-count')).toHaveText('0');
  expect(await written(request)).toEqual(before);
  await expect(outside(f)).toBeHidden();

  // Read again, the cameras are listed under Not set up by Hubble, and Move brings one back.
  await f.locator('[data-action="refresh-all"]').click();
  await expect(outsideRows(f)).toHaveCount(2);
  await expect(outside(f).locator('[data-role="outside-summary"]')).toHaveText('2 cameras');
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(0);
  expect(await written(request)).toEqual(before);
  await outside(f).getByRole('button', { name: 'Move 7 Jib to my cameras' }).click();
  await expect(named(setup(f), 'Jib')).toHaveCount(1);
  await expect(outsideRows(f)).toHaveCount(1);
});

// The read that follows one of Hubble's own sends takes what it finds as Hubble's, so a cleared camera needs
// remembering, or it would come back as if it were never cleared.
test('a send to the controller a cleared camera is on does not take it back into the workspace', async ({ page, request }) => {
  const f = await open(page, request);
  await eye(named(setup(f), 'Jib')).click();
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  // A reload keeps it remembered.
  await page.reload();
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await copyWideToMaster(f);
  expect(names((await fleet(request))[1]!).sort()).toEqual(['Jib', 'Wide']);
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect(outsideRows(f)).toHaveCount(1);
  await expect(outsideRows(f).first()).toContainText('Jib');
});

test('the bin clears a camera from its controller at once, copies first, in Manual send mode', async ({ page, request }) => {
  const f = await open(page, request);
  await copyWideToMaster(f);
  expect(names((await fleet(request))[1]!).sort()).toEqual(['Jib', 'Wide']);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Manual');
  await bin(named(setup(f), 'Wide')).click();
  const dialog = f.getByRole('dialog');
  await expect(dialog.locator('h3')).toHaveText('Clear camera 1 from Stage RIO?');
  await expect(dialog).toContainText('Its REMI copy on Master RCP comes off first.');
  await expect(dialog).toContainText('Nothing waits in Pending sends.');
  await dialog.getByRole('button', { name: 'Clear from Stage RIO' }).click();
  await expect(named(setup(f), 'Wide')).toHaveCount(0);
  await expect(toast(f)).toHaveText('Camera 1 cleared from Stage RIO');
  const devices = await fleet(request);
  expect(names(devices[0]!)).toEqual([]);
  expect(names(devices[1]!)).toEqual(['Jib']);
  await showPending(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send');
  await expect(outside(f)).toBeHidden();
});

test('a REMI copy whose camera is no longer in the workspace comes off its controller from the bin', async ({ page, request }) => {
  const f = await open(page, request);
  await copyWideToMaster(f);
  // The RIO is taken out of Devices, which takes its camera out of the workspace, and the copy is its own row.
  await f.locator('[data-tab="devices"]').click();
  await f.getByRole('button', { name: 'Remove Stage RIO from this list' }).click();
  await showSetup(f);
  const copy = named(setup(f), 'Wide');
  await expect(copy).toHaveCount(1);
  await expect(bin(copy)).toHaveAttribute('data-tip', 'Clear the REMI copy of camera 1 from Master RCP. The camera it copies stays where it is.');
  await bin(copy).click();
  const dialog = f.getByRole('dialog');
  await expect(dialog.locator('h3')).toHaveText('Clear the REMI copy of camera 1 from Master RCP?');
  await dialog.getByRole('button', { name: 'Clear from Master RCP' }).click();
  await expect(named(setup(f), 'Wide')).toHaveCount(0);
  await expect(toast(f)).toHaveText('The REMI copy of camera 1 cleared from Master RCP');
  const devices = await fleet(request);
  expect(names(devices[1]!)).toEqual(['Jib']);
  expect(names(devices[0]!)).toEqual(['Wide']);
});

test('with its controller off the bin says so and clears nothing, and the eye still works', async ({ page, request }) => {
  const f = await open(page, request);
  await request.post('/__simulate', { data: { power: { device: 1, on: false } } });
  await expect.poll(async () => {
    await bin(named(setup(f), 'Jib')).click();
    const blocked = await f.locator('[data-role="clear-rcp-blocked"]').count();
    if (!blocked) await f.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    return blocked;
  }, { timeout: 25000, intervals: [1000] }).toBe(1);
  const dialog = f.getByRole('dialog');
  await expect(dialog.locator('[data-role="clear-rcp-blocked"]')).toHaveText('Master RCP reads Offline, so it can’t be cleared from there now. The eye clears it from the workspace without it.');
  await expect(dialog.getByRole('button', { name: 'Clear from Master RCP' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await eye(named(setup(f), 'Jib')).click();
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  expect(names((await fleet(request))[1]!)).toEqual(['Jib']);
});

// Nov 21, 2026: "i just added a RIO and the camera not configured by myself showed up in my workspace".
test('a controller added by hand brings what is on it in under Not set up by Hubble, not as your cameras', async ({ page, request }) => {
  const f = await open(page, request);
  // Master RCP, which has Jib on it, goes out of Devices and is added back by typing its address.
  await f.locator('[data-tab="devices"]').click();
  await f.getByRole('button', { name: 'Remove Master RCP from this list' }).click();
  await expect(f.locator('[data-role="device-sheet"] tr[data-device-row]')).toHaveCount(2);
  const before = await written(request);
  const add = f.locator('[data-role="device-sheet"] [data-device-add]');
  await add.fill('10.192.1.20');
  await add.press('Enter');
  await expect(f.locator('[data-role="device-sheet"] tr[data-device-row]')).toHaveCount(3);
  await showSetup(f);
  await expect(named(setup(f), 'Jib')).toHaveCount(0);
  await expect(outsideRows(f)).toHaveCount(1);
  await expect(outsideRows(f).first()).toContainText('Jib');
  expect(await written(request)).toEqual(before);
  // Move makes it yours.
  await outside(f).getByRole('button', { name: 'Move 7 Jib to my cameras' }).click();
  await expect(named(setup(f), 'Jib')).toHaveCount(1);
});

// Nov 21, 2026: the browser's own hover text "takes way too long to show up for both trash and hide".
test('the eye, the bin and Clear workspace show their hover text at once, and it moves nothing', async ({ page, request }) => {
  const f = await open(page, request);
  const jib = named(setup(f), 'Jib'), tip = f.locator('.hc-quick-tip');
  await expect(eye(jib)).not.toHaveAttribute('title', /./);
  const before = await cell(jib, 'model').boundingBox();
  const started = Date.now();
  await eye(jib).hover();
  await expect(tip).toBeVisible({ timeout: 1000 });
  expect(Date.now() - started).toBeLessThan(800);
  await expect(tip).toContainText('Clear camera 7 from the workspace. Nothing on Master RCP changes');
  expect(await cell(jib, 'model').boundingBox()).toEqual(before);
  await bin(jib).hover();
  await expect(tip).toHaveText('Clear camera 7 from Master RCP. It is deleted there, with its REMI copies.');
  await setup(f).locator('[data-action="clear-workspace"]').hover();
  await expect(tip).toContainText('Clear every camera from this workspace.');
  await f.locator('[data-tab="setup"]').hover();
  await expect(tip).toBeHidden();
});

