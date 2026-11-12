import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';

// Every managed controller keeps a settings socket open, so a change made in Cyanview's own page shows up here with nothing pressed.
const simulate = (request: APIRequestContext, data: Record<string, unknown>) => request.post('/__simulate', { data });
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const rename = (request: APIRequestContext, fields: Record<string, string>) => simulate(request, { editCamera: { device: 0, key: 'wide', fields } });
async function openFleet(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true, live: true } });
  await page.goto('/');
  const ui = page.frameLocator('iframe');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await ui.locator('[data-tab="assignment"]').click().then(() => ui.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const rio = ui.locator('[data-controller="CY-RIO-1-10"]');
  if (!await rio.locator('input[data-field="name"]').isVisible()) await rio.locator('[data-action="toggle-controller"]').click();
  await expect(rio.locator('input[data-field="name"]')).toHaveValue('Wide');
  // Every controller's socket is open before a change is made.
  await expect.poll(async () => (await inspect(request)).openSockets).toEqual([1, 1, 1]);
  return { ui, rio, name: rio.locator('input[data-field="name"]'), ip: rio.locator('input[data-field="ip"]') };
}
/** Time from a change on the controller to the first animation frame showing it in the page. */
async function timeUntilShown(page: Page, field: string, value: string, change: () => Promise<unknown>) {
  const frame = page.frames().find(item => item !== page.mainFrame())!;
  const shown = frame.evaluate(([field, value]) => new Promise<number>((resolve, reject) => {
    const began = performance.now();
    const check = () => {
      const input = document.querySelector<HTMLInputElement>('[data-controller="CY-RIO-1-10"] input[data-field="' + field + '"]');
      if (input?.value === value) resolve(Math.round(performance.now() - began));
      else if (performance.now() - began > 5000) reject(new Error(field + ' never showed ' + value));
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }), [field, value] as const);
  await change();
  return shown;
}
async function openPending(ui: FrameLocator) {
  const list = ui.locator('[data-role="pending-sends"]');
  if (await list.isHidden()) await ui.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(list).toBeVisible();
  return list;
}

test('a rename made outside Hubble shows up with nothing pressed, and a pending edit stays pending', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { ui, name, ip } = await openFleet(page, request);
  // A Manual edit waits in Pending sends.
  await ip.fill('10.20.20.42'); await ip.press('Enter');
  await expect(await openPending(ui)).toContainText('10.20.20.42');
  const elapsed = await timeUntilShown(page, 'name', 'Renamed in Cyanview', () => rename(request, { Name: 'Renamed in Cyanview' }));
  console.log('Outside rename to first frame showing it: ' + elapsed + ' ms (the preview polls state every 200 ms; Hubble pushes it)');
  await expect(ip).toHaveValue('10.20.20.42');
  await expect(await openPending(ui)).toContainText('10.20.20.42');
  // A second change made outside follows the same way.
  await rename(request, { Name: 'Renamed again' });
  await expect(name).toHaveValue('Renamed again');
  await expect(ip).toHaveValue('10.20.20.42');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const { fleet } = await inspect(request);
  expect(fleet[0].actions, 'Nothing was sent to the controller').toHaveLength(0);
  expect(errors).toEqual([]);
});

test('typing in a cell carries on through a change made outside Hubble', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { name, ip } = await openFleet(page, request);
  await name.locator('..').dblclick(); await name.fill('Typing while');
  await rename(request, { IP: '10.20.20.77' });
  await expect(ip).toHaveValue('10.20.20.77');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Typing while');
  await page.keyboard.press('End'); await page.keyboard.type(' it changed'); await page.keyboard.press('Enter');
  await expect(name).toHaveValue('Typing while it changed');
  expect(errors).toEqual([]);
});

test('after the worker restarts, changes made outside still show up', async ({ page, request }) => {
  const { name } = await openFleet(page, request);
  await request.post('/__restart');
  await expect.poll(async () => (await inspect(request)).openSockets).toEqual([1, 1, 1]);
  await rename(request, { Name: 'After a restart' });
  await expect(name).toHaveValue('After a restart');
});
