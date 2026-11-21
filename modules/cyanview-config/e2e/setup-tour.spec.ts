import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';

// The setup tour walks the page in setup order: each stop lights one part, points at it and says
// what it is for and what to do there, and Next moves on whether or not it was done. These drive it
// with real clicks and keys against the preview's controllers, real or simulated.
const STOPS = 25;
const ui = (page: Page) => page.frameLocator('iframe');
const card = (page: Page) => ui(page).locator('.cv-tour-card');
const spot = (page: Page) => ui(page).locator('.cv-tour-spot');
const title = (page: Page) => card(page).locator('#cv-tour-title');
const count = (page: Page) => card(page).locator('.cv-tour-count');
const toggle = (page: Page) => ui(page).getByRole('button', { name: 'Setup tour', exact: true });
async function open(page: Page, request: APIRequestContext, simulated: boolean) {
  await request.post('/__reset', { data: simulated ? { simulated: true, tour: true } : { sample: false, tour: true } });
  await page.goto('/');
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText(simulated ? 'Simulated' : 'Workspace saved');
}
async function goTo(page: Page, stop: number) {
  for (let guard = 0; guard < STOPS; guard += 1) {
    const at = Number((await count(page).textContent())?.split(' ')[0]);
    if (at === stop) return;
    await card(page).getByRole('button', { name: at < stop ? 'Next' : 'Back', exact: true }).click();
  }
  await expect(count(page)).toHaveText(stop + ' of ' + STOPS);
}
// The ring sits 5 px outside what it lights once it has glided there.
async function ringsAround(page: Page, box: () => Promise<{ x: number; y: number; width: number; height: number } | null>) {
  await expect.poll(async () => {
    const [a, b] = await Promise.all([spot(page).boundingBox(), box()]);
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(a.x + 5 - b.x), Math.abs(a.y + 5 - b.y), Math.abs(a.width - 10 - b.width), Math.abs(a.height - 10 - b.height));
  }, { timeout: 5000 }).toBeLessThan(2);
}
const around = (target: Locator) => () => target.boundingBox();
async function findRig(page: Page) {
  const f = ui(page);
  await f.getByRole('button', { name: 'Network range', exact: true }).click();
  await f.getByRole('listbox', { name: 'Network range' }).getByRole('option', { name: '10.192.0.0/16', exact: true }).click();
  await f.getByRole('button', { name: 'Discover', exact: true }).click();
  await f.locator('[data-action="add-all-found"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('3');
}

test('starts by itself on a new setup, and Next walks the page in setup order without anything being done', async ({ page, request }) => {
  await open(page, request, false);
  const f = ui(page);
  // No side panel any more: the tour is the setup guide.
  await expect(f.getByRole('complementary', { name: 'Cyanview setup guide' })).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page).getByRole('button', { name: 'Next', exact: true })).toBeFocused();
  await expect(count(page)).toHaveText('1 of ' + STOPS);
  await expect(card(page).locator('.cv-tour-step-title')).toHaveText('Find your controllers');
  await expect(title(page)).toHaveText('Devices');
  await expect(card(page).locator('.cv-tour-todo')).toHaveText('What to do: Start here. Finding your controllers happens on this tab.');
  await ringsAround(page, around(f.locator('.hc-tabs [data-tab="devices"]')));
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(title(page)).toHaveText('Network range');
  await ringsAround(page, around(f.getByRole('button', { name: 'Network range', exact: true })));
  // The arrow keys move through the stops while the card has focus.
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('Discovery method');
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('Discover');
  await ringsAround(page, around(f.getByRole('button', { name: 'Discover', exact: true })));
  // The tour opens each stop's tab itself.
  await goTo(page, 12);
  await expect(title(page)).toHaveText('Camera Configuration');
  await expect(card(page).locator('.cv-tour-step-title')).toHaveText('Add your cameras');
  await expect(f.locator('.hc-tabs [data-tab="setup"]')).toHaveAttribute('aria-selected', 'true');
  await ringsAround(page, around(f.locator('.hc-tabs [data-tab="setup"]')));
  await goTo(page, 21);
  await expect(title(page)).toHaveText('REMI Matrix');
  await expect(f.locator('.hc-tabs [data-tab="assignment"]')).toHaveAttribute('aria-selected', 'true');
  // Walking through changed nothing on the page.
  await expect(f.locator('[data-role="device-count"]')).toHaveText('0');
});

test('Back goes back, Exit tour and Esc leave, and it starts by itself only once', async ({ page, request }) => {
  await open(page, request, false);
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(title(page)).toHaveText('Discovery method');
  await card(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(title(page)).toHaveText('Network range');
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await expect(card(page)).toBeHidden();
  await expect(spot(page)).toBeHidden();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();
  // Having started by itself is kept on this Mac by the worker, so a reload doesn't start it again.
  await expect.poll(async () => (await (await request.post('/__rpc', { data: { commandId: 'setup-guide', value: null } })).json()).result?.offered).toBe(true);
  await page.reload();
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect(card(page)).toBeHidden();
  // Setup tour starts it again from the beginning, and Esc leaves it.
  await toggle(page).click();
  await expect(count(page)).toHaveText('1 of ' + STOPS);
  await expect(card(page).getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(card(page)).toBeHidden();
});

test('on a simulated rig each card says what is already done, counting cameras as the page does', async ({ page, request }) => {
  await open(page, request, true);
  const f = ui(page);
  await expect(f.locator('.cv-simulated-pill')).toHaveText('Simulated');
  await expect(card(page)).toBeVisible();
  await goTo(page, 4);
  await expect(card(page).locator('.cv-tour-what')).toHaveText('Looks for controllers in the range. It only reads, so nothing on them changes. This is Simulated: it finds a simulated RIO and two RCPs on any network.');
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  // Doing the work with the tour shut, then starting it again.
  await findRig(page);
  await toggle(page).click();
  await expect(card(page)).toHaveAttribute('data-done', 'true');
  await expect(card(page).locator('.cv-tour-done')).toBeVisible();
  await expect(card(page).locator('.cv-tour-status')).toHaveText('You have 3 controllers. 3 are online.');
  // Only a step's first stop says where it stands.
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card(page).locator('.cv-tour-status')).toBeHidden();
  await goTo(page, 8);
  await expect(card(page)).toHaveAttribute('data-done', 'false');
  await expect(card(page).locator('.cv-tour-status')).toHaveText('3 controllers are still named by serial number.');
  // The rig's two cameras each have REMI copies on both RCPs; a copy is not another camera.
  await goTo(page, 12);
  await expect(f.locator('[data-role="camera-count"]')).toHaveText('2');
  await expect(card(page).locator('.cv-tour-status')).toHaveText('You have 2 cameras.');
  await goTo(page, 18);
  await expect(card(page).locator('.cv-tour-status')).toHaveText('Everything has been sent and confirmed.');
  await goTo(page, 21);
  await expect(card(page).locator('.cv-tour-status')).toHaveText('4 REMI copies on other RCPs.');
});

test('a column is lit whole, heading to last row, and the card never covers the sheet', async ({ page, request }) => {
  await open(page, request, true);
  const f = ui(page);
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await findRig(page);
  await toggle(page).click();
  await goTo(page, 8);
  await expect(title(page)).toHaveText('Name');
  const sheet = f.locator('[data-role="device-sheet"] table');
  const head = sheet.locator('thead th').filter({ hasText: /^Name$/ });
  await ringsAround(page, async () => {
    const [h, t] = await Promise.all([head.boundingBox(), sheet.boundingBox()]);
    return h && t ? { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y } : null;
  });
  const [table, box] = await Promise.all([sheet.boundingBox(), card(page).boundingBox()]);
  expect(box!.y).toBeGreaterThan(table!.y + table!.height);
  await expect(f.locator('.cv-tour-lines')).toBeVisible();
  // Source on Camera Configuration is lit the same way.
  await goTo(page, 15);
  const source = f.locator('[data-controller="__camera-setup__"] th[data-field-header="source"]');
  const setup = source.locator('xpath=ancestor::table[1]');
  await ringsAround(page, async () => {
    const [h, t] = await Promise.all([source.boundingBox(), setup.boundingBox()]);
    return h && t ? { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y } : null;
  });
});

test('the steps that happen in HubDash wait in the middle with nothing lit, and tick from keys and a press', async ({ page, request }) => {
  await open(page, request, false);
  await goTo(page, 24);
  await expect(title(page)).toHaveText('Add Cyanview actions');
  await expect(spot(page)).toBeHidden();
  await expect(ui(page).locator('.cv-tour-lines')).toBeHidden();
  const viewport = page.viewportSize()!, box = (await card(page).boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThan(4);
  await expect(card(page).locator('.cv-tour-status')).toBeHidden();
  await request.post('/__simulate', { data: { keys: [{ id: 'key-1', fields: { values: { enabled: true, actionType: 'select-camera', 'module.controllerId': '', 'module.cameraNumber': 1 } } }] } });
  await expect(card(page).locator('.cv-tour-status')).toHaveText('1 key uses Cyanview.');
  await expect(card(page)).toHaveAttribute('data-done', 'true');
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(title(page)).toHaveText('Press a key');
  await expect(card(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await request.post('/__simulate', { data: { press: { actionType: 'select-camera', 'module.controllerId': '', 'module.cameraNumber': 1 } } });
  await expect(card(page).locator('.cv-tour-status')).toHaveText('A Cyanview key has been pressed.');
  // A press seen once stays done, though the worker forgets presses when it restarts.
  await expect.poll(async () => (await (await request.post('/__rpc', { data: { commandId: 'setup-guide', value: null } })).json()).result?.confirmed).toEqual(['press']);
  await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page)).toBeHidden();
});

test('the page stays usable under the tour, which keeps still for reduced motion and follows light mode', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await open(page, request, true);
  const f = ui(page);
  await goTo(page, 2);
  await expect(spot(page)).toBeVisible();
  await expect(f.locator('.cv-tour-lead')).toHaveCSS('animation-name', 'none');
  await expect(card(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // The lit control works through the tour, and the tour stays where it was.
  await f.getByRole('button', { name: 'Network range', exact: true }).click();
  await f.getByRole('listbox', { name: 'Network range' }).getByRole('option', { name: '10.192.0.0/16', exact: true }).click();
  await expect(f.getByRole('button', { name: 'Network range', exact: true })).toContainText('10.192.0.0/16');
  await expect(title(page)).toHaveText('Network range');
});
