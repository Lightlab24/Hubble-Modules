import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Camera Enabled is Cyanview's own Enabled on each camera. A REMI copy follows its source, and Refresh
// switches a camera off and on again, then its copies.
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const enabledWrites = (actions: any[]) => actions.map(action => action.update?.changes?.enabled).filter((value: unknown) => value !== undefined);
async function openWithCopy(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true, live: true } });
  await page.goto('/');
  const ui = page.frameLocator('iframe');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await ui.locator('[data-tab="assignment"]').click().then(() => ui.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const sheet = (id: string) => ui.locator('[data-controller="' + id + '"]');
  const master = sheet('CY-RCP-1-20');
  if (!await master.locator('[data-camera-count]').isVisible()) await master.locator('[data-action="toggle-controller"]').click();
  await master.locator('[data-action="open-remi-panel"]').click();
  await master.locator('[data-remi-panel]').getByRole('button', { name: 'Add', exact: true }).click();
  await master.locator('[data-action="send-controller"]').click();
  await ui.locator('[data-remi-apply]').click();
  await expect(master.locator('[data-remi-model]')).toHaveText('Venice-IP');
  for (const id of ['CY-RIO-1-10', 'CY-RCP-1-20']) if (!await sheet(id).locator('td[data-column="cameraEnabled"]').first().isVisible()) await sheet(id).locator('[data-action="toggle-controller"]').click();
  const cell = (id: string) => sheet(id).locator('td[data-column="cameraEnabled"]').first();
  await expect(cell('CY-RIO-1-10').getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
  return { ui, cell, source: cell('CY-RIO-1-10'), copy: cell('CY-RCP-1-20') };
}

test('Off and On switch a camera on its controller, its copy follows, and the copy\'s own switch is locked', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { ui, source, copy } = await openWithCopy(page, request);
  await expect(copy.getByRole('button', { name: 'On', exact: true })).toBeDisabled();
  await expect(copy).toContainText('follows Stage RIO');
  // Camera Control Enabled is a different column and stays as it was.
  await source.getByRole('button', { name: 'Off', exact: true }).click();
  await expect(source.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 300 });
  await expect(ui.getByText('Camera 1 on Stage RIO switched off with 1 copy')).toBeVisible();
  await expect.poll(async () => (await inspect(request)).fleet.map((device: any) => Object.values(device.config.Camera).map((camera: any) => camera.Enabled).join(''))).toEqual(['0', '0', '']);
  await expect(copy.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await source.getByRole('button', { name: 'On', exact: true }).click();
  await expect(ui.getByText('Camera 1 on Stage RIO switched on with 1 copy')).toBeVisible();
  await expect(copy.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const { fleet } = await inspect(request);
  expect(enabledWrites(fleet[0].actions)).toEqual(['0', '1']);
  expect(enabledWrites(fleet[1].actions)).toEqual(['0', '1']);
  expect(errors).toEqual([]);
});

test('the refresh button switches the camera off and on, then its copy, without touching the switch', async ({ page, request }) => {
  const { ui, source } = await openWithCopy(page, request);
  const refresh = source.getByRole('button', { name: 'Refresh camera 1 on Stage RIO' });
  await refresh.click();
  // It says what it is doing while it runs, and can't be pressed twice.
  await expect(refresh).toBeDisabled();
  await expect(source.locator('[data-camera-enabled-note]')).toHaveText(/Off, turning on…|Refreshing copies…/);
  await expect(ui.getByText('Camera 1 on Stage RIO refreshed with 1 copy')).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(source.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const { fleet } = await inspect(request);
  expect(enabledWrites(fleet[0].actions)).toEqual(['0', '1']);
  expect(enabledWrites(fleet[1].actions)).toEqual(['0', '1']);
});

test('Refresh camera on a copy\'s right-click menu refreshes only that copy', async ({ page, request }) => {
  const { ui, copy } = await openWithCopy(page, request);
  await copy.locator('xpath=..').locator('td[data-column="model"]').click({ button: 'right' });
  await ui.getByRole('menuitem', { name: 'Refresh camera', exact: true }).click();
  await expect(ui.getByText('Camera 1 on Master RCP refreshed')).toBeVisible();
  const { fleet } = await inspect(request);
  expect(enabledWrites(fleet[0].actions)).toEqual([]);
  expect(enabledWrites(fleet[1].actions)).toEqual(['0', '1']);
});

test('a camera switched off in Cyanview\'s own page shows Off here, and its copy follows', async ({ page, request }) => {
  const { source, copy } = await openWithCopy(page, request);
  await expect.poll(async () => (await inspect(request)).openSockets).toEqual([1, 1, 1]);
  await request.post('/__simulate', { data: { editCamera: { device: 0, key: 'wide', fields: { Enabled: '0' } } } });
  await expect(source.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(copy.getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await request.post('/__simulate', { data: { editCamera: { device: 0, key: 'wide', fields: { Enabled: '1' } } } });
  await expect(copy.getByRole('button', { name: 'On', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const { fleet } = await inspect(request);
  expect(enabledWrites(fleet[0].actions), 'Nothing is written to the camera that was changed outside').toEqual([]);
  expect(enabledWrites(fleet[1].actions)).toEqual(['0', '1']);
});
