import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

// The setup guide is a side panel beside whichever tab is open, drawn like HubDash's Guided setup.
// These drive it with real clicks against the preview's simulated controllers.
const ui = (page: Page) => page.frameLocator('iframe');
const panel = (page: Page) => ui(page).getByRole('complementary', { name: 'Cyanview setup guide' });
const step = (page: Page, id: string) => panel(page).locator('li[data-step="' + id + '"]');
async function open(page: Page, request: APIRequestContext, sample: boolean) {
  await request.post('/__reset', { data: { sample } });
  await page.goto('/');
  await expect(ui(page).locator('#cyanview-design')).toBeVisible();
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText(sample ? 'Simulated' : 'Workspace saved');
}

test('opens by itself on a new setup and takes you to Discover', async ({ page, request }) => {
  await open(page, request, false);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('heading', { name: 'Cyanview setup' })).toBeVisible();
  await expect(panel(page).locator('.guided-setup-header p')).toHaveText('0 of 7 done');
  await expect(step(page, 'find')).toHaveAttribute('data-status', 'current');
  await expect(step(page, 'find').getByText('No Cyanview gear here? Turn on Simulated for Cyanview in Module Connections')).toBeVisible();
  // It takes its own column: the page's own controls end where the panel begins.
  const main = await ui(page).locator('.hc-main').boundingBox(), side = await panel(page).boundingBox();
  expect(main!.x + main!.width).toBeLessThanOrEqual(side!.x + 1);
  expect(side!.width).toBeCloseTo(312, 0);
  await ui(page).getByRole('tab', { name: /Camera Configuration/ }).click();
  await panel(page).getByRole('button', { name: 'Open Devices' }).click();
  await expect(ui(page).getByRole('tab', { name: /Devices/ })).toHaveAttribute('aria-selected', 'true');
  await expect(ui(page).getByRole('button', { name: 'Network range' })).toBeFocused();
});

test('closes, reopens from the header and keeps that across a reload', async ({ page, request }) => {
  await open(page, request, false);
  const toggle = ui(page).getByRole('button', { name: 'Setup guide', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await panel(page).getByRole('button', { name: 'Close setup guide' }).click();
  await expect(panel(page)).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toBeFocused();
  // The panel shuts at once; the worker's copy follows behind it.
  await expect.poll(async () => (await (await request.post('/__rpc', { data: { commandId: 'setup-guide', value: null } })).json()).result?.open).toBe(false);
  await page.reload();
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  // It opened by itself once; closed by hand, it stays closed.
  await expect(panel(page)).toBeHidden();
  await toggle.click();
  await expect(panel(page)).toBeVisible();
});

test('a simulated rig says so, and its steps tick as it is found, added and sent', async ({ page, request }) => {
  await request.post('/__reset', { data: { simulated: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Simulated');
  await expect(f.locator('.cv-simulated-pill')).toHaveText('Simulated');
  // A new simulated setup has no controllers, so the panel opens by itself.
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.guided-setup-note')).toContainText('Simulated. You’re working on a simulated RIO and RCPs');
  await expect(step(page, 'find')).toContainText('This is Simulated: Discover finds a simulated RIO and two RCPs on any network.');
  await panel(page).getByRole('button', { name: 'Open Devices' }).click();
  await expect(f.getByRole('button', { name: 'Network range', exact: true })).toBeFocused();
  await f.getByRole('button', { name: 'Network range', exact: true }).click();
  await f.getByRole('listbox', { name: 'Network range' }).getByRole('option', { name: '10.192.0.0/16', exact: true }).click();
  await f.getByRole('button', { name: 'Discover', exact: true }).click();
  await f.locator('[data-action="add-all-found"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('3');
  // The rig comes with cameras on the RIO and REMI copies on both RCPs, all sent; the controllers
  // still carry their serial numbers as names.
  for (const id of ['find', 'cameras', 'send', 'remi']) await expect(step(page, id)).toHaveAttribute('data-status', 'done');
  await expect(step(page, 'name')).toHaveAttribute('data-status', 'current');
  await expect(step(page, 'name')).toContainText('3 controllers are still named by serial number.');
  await expect(panel(page).locator('.guided-setup-header p')).toHaveText('4 of 7 done');
  // An edit waits to send, which puts Send back; the panel's own Send sends it.
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const rio = f.locator('[data-controller="CY-RIO-1-10"]'), wide = rio.locator('tr[data-id]').first();
  if (!await wide.isVisible()) await rio.locator('[data-action="toggle-controller"]').click();
  await wide.locator('[data-field="name"]').fill('Wide practice'); await wide.locator('[data-field="name"]').press('Enter');
  // Name is still the current step, so Send goes back to waiting behind it; open it to use it.
  await expect(step(page, 'send')).toHaveAttribute('data-status', 'upcoming');
  await step(page, 'send').getByRole('button', { name: /Send to the controllers/ }).click();
  await panel(page).getByRole('button', { name: /^Send \d+$/ }).click();
  await expect(wide.locator('[data-column="sync"]')).toContainText('In sync');
  await expect(step(page, 'send')).toHaveAttribute('data-status', 'done');
});

test('Skip for now moves on, and Go back to this step returns', async ({ page, request }) => {
  await open(page, request, false);
  await step(page, 'find').getByRole('button', { name: 'Skip for now' }).click();
  await expect(step(page, 'find')).toHaveAttribute('data-status', 'skipped');
  await expect(step(page, 'name')).toHaveAttribute('data-status', 'current');
  await expect(panel(page).locator('.guided-setup-header p')).toHaveText('1 of 7 done');
  await step(page, 'find').getByRole('button', { name: /Find your controllers/ }).click();
  await step(page, 'find').getByRole('button', { name: 'Go back to this step' }).click();
  await expect(step(page, 'find')).toHaveAttribute('data-status', 'current');
});

test('keys that use Cyanview and a press tick the last two steps', async ({ page, request }) => {
  await open(page, request, false);
  await expect(step(page, 'actions')).toHaveAttribute('data-status', 'upcoming');
  await request.post('/__simulate', { data: { keys: [{ id: 'key-1', fields: { values: { enabled: true, actionType: 'select-camera', 'module.controllerId': '', 'module.cameraNumber': 1 } } }] } });
  await expect(step(page, 'actions')).toHaveAttribute('data-status', 'done');
  await request.post('/__simulate', { data: { press: { actionType: 'select-camera', 'module.controllerId': '', 'module.cameraNumber': 1 } } });
  await expect(step(page, 'press')).toHaveAttribute('data-status', 'done');
  // The page reads its progress back from the worker, so a reload keeps it.
  await page.reload();
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  // It opened by itself on this new setup and nobody closed it, so it is still open.
  await expect(panel(page)).toBeVisible();
  await expect(step(page, 'press')).toHaveAttribute('data-status', 'done');
});
