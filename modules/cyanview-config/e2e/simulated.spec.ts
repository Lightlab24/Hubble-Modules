import { expect, test, type Page } from '@playwright/test';

// Simulated runs the worker against the controllers simulated inside it, and the page works as it does live.
const ui = (page: Page) => page.frameLocator('iframe');
async function pick(frame: ReturnType<typeof ui>, label: string, option: string) {
  await frame.getByRole('button', { name: label, exact: true }).click();
  await frame.getByRole('listbox', { name: label }).getByRole('option', { name: option, exact: true }).click();
}

test('Simulated: Discover finds the simulated rig, which is added, reads Online and takes a send', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await request.post('/__reset', { data: { simulated: true } });
  await page.goto('/'); const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Simulated');
  await pick(f, 'Network range', '10.192.0.0/16');
  await f.getByRole('button', { name: 'Discover', exact: true }).click();
  // What a search finds lists as rows in the Devices sheet.
  const found = f.locator('[data-role="device-sheet"] tr[data-device-found]');
  await expect(found).toHaveCount(3);
  for (const serial of ['CY-RIO-1-10', 'CY-RCP-1-20', 'CY-RCP-1-30']) await expect(found.filter({ hasText: serial })).toHaveCount(1);
  await expect(f.locator('[data-action="add-all-found"]')).toHaveText('Add all 3');
  await f.locator('[data-action="add-all-found"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('3');
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  // Each controller's MQTT says it is up, as a real one's does.
  for (const serial of ['CY-RIO-1-10', 'CY-RCP-1-20', 'CY-RCP-1-30'])
    await expect(f.locator(`[data-controller="${serial}"] .hc-controller-header > .hc-status`)).toHaveText('Online');
  const rio = f.locator('[data-controller="CY-RIO-1-10"]'), wide = rio.locator('tr[data-id]').first();
  if (!await wide.isVisible()) await rio.locator('[data-action="toggle-controller"]').click();
  await expect(wide.locator('[data-field="name"]')).toHaveValue('Wide');
  await expect(rio.locator('tr[data-id]')).toHaveCount(2);
  await wide.locator('[data-field="name"]').fill('Wide simulated'); await wide.locator('[data-field="name"]').press('Enter');
  await expect(wide.locator('[data-column="sync"]')).toContainText('Pending');
  await rio.locator('[data-action="send-controller"]').click();
  await expect(wide.locator('[data-column="sync"]')).toContainText('In sync');
  // The simulated RIO has the new name, as a read of it says.
  const read = await (await request.post('/__rpc', { data: { operation: 'call', commandId: 'refresh', value: null } })).json();
  const names = read.result.snapshots.find((snapshot: any) => snapshot.device.serial === 'CY-RIO-1-10').cameras.map((camera: any) => camera.name);
  expect(names).toEqual(['Wide simulated', 'Tight']);
  await f.getByRole('button', { name: 'Refresh all', exact: true }).click();
  await expect(wide.locator('[data-field="name"]')).toHaveValue('Wide simulated');
  await expect(wide.locator('[data-column="sync"]')).toContainText('In sync');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Simulated');
  await page.screenshot({ path: 'artifacts/cyanview-0.1.92-simulated.png' });
  // The preview's own loopback controller was never reached.
  expect((await (await request.get('/__inspect')).json()).actions).toHaveLength(0);
  expect(errors).toEqual([]);
});
