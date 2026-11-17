import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// A page reads the saved plan only when it opens. If another page saves the same workspace (a second
// window, or a test driving the live page, as happened on Nov 17, 2026), this page has to keep saving
// what its user sees, or every edit is refused and sends can't find what was added since.
const frame = (page: Page) => page.frameLocator('iframe');
const rpc = async (request: APIRequestContext, commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json());
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const saved = async (request: APIRequestContext) => (await rpc(request, 'read-plan')).result.plan;
const toast = (f: FrameLocator) => f.locator('[data-role="toast"]');

async function anotherEditorSaves(request: APIRequestContext, change: (plan: any) => void) {
  const current = (await rpc(request, 'read-plan')).result;
  const plan = structuredClone(current.plan);
  change(plan);
  const reply = await rpc(request, 'save-plan', { revision: current.revision, plan });
  expect(reply.error, 'the other editor saves').toBeUndefined();
}

test('a page opened before another editor saved still saves its edits, with no conflict and the cell kept', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  await page.goto('/');
  const f = frame(page);
  await expect(f.locator('#cyanview-design')).toBeVisible();
  await f.locator('[data-tab="assignment"]').click().then(() => f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const group = f.locator('[data-controller="rcp1"]');
  await expect(group.getByRole('button', { name: 'Choose visible columns' })).toBeVisible();
  await expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);

  await anotherEditorSaves(request, plan => { plan.devices[0].name = 'Renamed in another window'; });

  const name = group.locator('[data-hubble-row="cam2"][data-hubble-column="name"]');
  await name.dblclick();
  await name.locator('input').fill('Shot 2');
  await name.locator('input').press('Enter');
  await expect.poll(async () => (await saved(request)).cameras.find((camera: { id: string }) => camera.id === 'cam2')?.name).toBe('Shot 2');
  await expect(f.locator('[data-role="saved-label"]')).not.toContainText('not saved');
  await expect(toast(f)).not.toContainText('another editor');
  // Enter moves to the next row and the sheet keeps the keyboard.
  expect(await f.locator('body').evaluate(() => !!document.activeElement?.closest('[data-controller="rcp1"]'))).toBe(true);

  // A second edit saves too.
  const next = group.locator('[data-hubble-row="cam3"][data-hubble-column="name"]');
  await next.dblclick();
  await next.locator('input').fill('Shot 3');
  await next.locator('input').press('Enter');
  await expect.poll(async () => (await saved(request)).cameras.find((camera: { id: string }) => camera.id === 'cam3')?.name).toBe('Shot 3');
  await expect(toast(f)).not.toContainText('another editor');
});

test('a device added after another editor saved is saved, and a send to it reaches it', async ({ page, request }) => {
  const LEAF = 'CY-RCP-1-30', MASTER = 'CY-RCP-1-20';
  await request.post('/__reset', { data: { sample: false, remi: true } });
  await page.goto('/');
  const f = frame(page);
  const sheet = f.locator('[data-role="device-sheet"]');
  const row = (id: string) => sheet.locator('tr[data-device-row="' + id + '"]');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(row(LEAF)).toBeVisible();
  await row(LEAF).locator('[data-action="remove-device"]').click();
  await expect(sheet.locator('tr[data-device-row]')).toHaveCount(2);
  await expect.poll(async () => (await saved(request)).devices.length).toBe(2);

  await anotherEditorSaves(request, plan => { plan.devices.find((device: { id: string }) => device.id === MASTER).name = 'Renamed in another window'; });

  await sheet.locator('[data-device-add]').fill('10.192.1.30');
  await sheet.locator('[data-device-add]').press('Enter');
  await expect(row(LEAF)).toBeVisible();
  await expect.poll(async () => (await saved(request)).devices.map((device: { id: string }) => device.id)).toContain(LEAF);
  await expect(toast(f)).not.toContainText('another editor');

  // The send reads the saved plan, so it finds the device the page added.
  await sheet.locator('[data-action="toggle-device-group"][data-group="lan"]').click();
  const second = sheet.locator('[data-device-cell="' + LEAF + ':lan2"]');
  await second.fill('10.20.101.213');
  await second.press('Enter');
  const panel = f.locator('[data-role="pending-sends"]');
  if (await panel.isHidden()) await f.locator('#hc-devices .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel.locator('[data-pending-lan-send="' + LEAF + '"]').click();
  await expect(panel).toContainText('Nothing is waiting to send');
  const fleet = (await inspect(request)).fleet as { config: { IP: Record<string, { IP: string }> } }[];
  expect(Object.values(fleet[2]!.config.IP).map(item => item.IP)).toContain('10.20.101.213');
});
