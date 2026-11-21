import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';

// The setup tour walks the page in setup order: each stop rings one part and points at it with its
// name, and a panel fixed at the bottom says what it is for and what to do there, with Next always in
// the same place. Next moves on whether or not it was done. These drive it with real clicks and keys
// against the preview's controllers, real or simulated.
const STOPS = 13;
const ui = (page: Page) => page.frameLocator('iframe');
const card = (page: Page) => ui(page).locator('.cv-tour-panel');
const spot = (page: Page) => ui(page).locator('.cv-tour-spot');
const title = (page: Page) => card(page).locator('#cv-tour-title');
const count = (page: Page) => card(page).locator('.cv-tour-count');
const toggle = (page: Page) => ui(page).getByRole('button', { name: 'Setup tour', exact: true });
const tag = (page: Page) => ui(page).locator('.cv-tour-tag');
const next = (page: Page) => card(page).getByRole('button', { name: /^(Next|Done)$/ });
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
  await expect(title(page)).toHaveText('Discover');
  await expect(tag(page)).toHaveText('Discover');
  await expect(card(page).locator('.cv-tour-todo')).toHaveText('What to do: Pick your network, press Discover, then Add them to Devices.');
  // The network list, the discovery method and Discover are rung together.
  await ringsAround(page, async () => {
    const [a, b] = await Promise.all([f.getByRole('button', { name: 'Network range', exact: true }).boundingBox(), f.getByRole('button', { name: 'Discover', exact: true }).boundingBox()]);
    return a && b ? { x: a.x, y: Math.min(a.y, b.y), width: b.x + b.width - a.x, height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) } : null;
  });
  // The arrow keys move through the stops while the panel has focus.
  await page.keyboard.press('ArrowRight');
  await expect(title(page)).toHaveText('Name');
  await expect(card(page).locator('.cv-tour-step-title')).toHaveText('Name your controllers');
  // The tour opens each stop's tab itself.
  await goTo(page, 5);
  await expect(title(page)).toHaveText('Number of cameras');
  await expect(f.locator('.hc-tabs [data-tab="setup"]')).toHaveAttribute('aria-selected', 'true');
  await goTo(page, 10);
  await expect(title(page)).toHaveText('Master RCP');
  await expect(f.locator('.hc-tabs [data-tab="assignment"]')).toHaveAttribute('aria-selected', 'true');
  // Walking through changed nothing on the page.
  await expect(f.locator('[data-role="device-count"]')).toHaveText('0');
});

test('Next, Back and Exit tour stay in the same place on every stop, at the bottom', async ({ page, request }) => {
  await open(page, request, true);
  const f = ui(page);
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await findRig(page);
  await toggle(page).click();
  const places = new Set<string>(), viewport = page.viewportSize()!;
  for (let stop = 1; stop <= STOPS; stop += 1) {
    await expect(count(page)).toHaveText(stop + ' of ' + STOPS);
    const boxes = await Promise.all(['Exit tour', 'Back', /^(Next|Done)$/].map(name => card(page).getByRole('button', { name }).boundingBox()));
    places.add(boxes.map(box => [box!.x, box!.y].map(Math.round).join(',')).join(' '));
    expect(boxes[2]!.y).toBeGreaterThan(viewport.height * 0.75);
    if (stop < STOPS) await next(page).click();
  }
  expect([...places]).toHaveLength(1);
  // Nothing in the step line says Done; a finished step shows its tick.
  await goTo(page, 1);
  await expect(card(page)).toHaveAttribute('data-done', 'true');
  await expect(card(page).locator('.cv-tour-step')).not.toContainText('Done');
  await expect(f.locator('.cv-tour-marker svg')).toBeVisible();
});

test('Back goes back, Exit tour and Esc leave, and it starts by itself only once', async ({ page, request }) => {
  await open(page, request, false);
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(title(page)).toHaveText('Status and Base IP');
  await card(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(title(page)).toHaveText('Name');
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

test('on a simulated rig each step says where it stands, counting cameras as the page does', async ({ page, request }) => {
  await open(page, request, true);
  const f = ui(page);
  await expect(f.locator('.cv-simulated-pill')).toHaveText('Simulated');
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator('.cv-tour-what')).toContainText('This is Simulated: it finds a simulated RIO and two RCPs on any network.');
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  // Doing the work with the tour shut, then starting it again.
  await findRig(page);
  await toggle(page).click();
  await expect(card(page)).toHaveAttribute('data-done', 'true');
  await expect(card(page).locator('.cv-tour-status')).toHaveText('You have 3 controllers. 3 are online.');
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card(page)).toHaveAttribute('data-done', 'false');
  await expect(card(page).locator('.cv-tour-status')).toHaveText('3 controllers are still named by serial number.');
  // Only a step's first stop says where it stands.
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(card(page).locator('.cv-tour-status')).toBeHidden();
  // The rig's two cameras each have REMI copies on both RCPs; a copy is not another camera.
  await goTo(page, 5);
  await expect(f.locator('[data-role="camera-count"]')).toHaveText('2');
  await expect(card(page).locator('.cv-tour-status')).toHaveText('You have 2 cameras.');
  await goTo(page, 8);
  await expect(card(page).locator('.cv-tour-status')).toHaveText('Everything has been sent and confirmed.');
  await goTo(page, 10);
  await expect(card(page).locator('.cv-tour-status')).toHaveText('4 REMI copies on other RCPs.');
});

test('a column is rung whole however its heading reads, sorted or with its group open', async ({ page, request }) => {
  await open(page, request, true);
  const f = ui(page);
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await findRig(page);
  // Sorted by Name, the heading reads "Name ↑"; with LAN open, its group reads differently too.
  await f.getByRole('button', { name: 'Sort by Name' }).click();
  await f.getByRole('button', { name: 'Expand LAN IP settings' }).click();
  await toggle(page).click();
  await goTo(page, 2);
  await expect(title(page)).toHaveText('Name');
  await expect(tag(page)).toHaveText('Name');
  const sheet = f.locator('[data-role="device-sheet"] table');
  const column = (head: Locator) => async () => {
    const [h, t] = await Promise.all([head.boundingBox(), sheet.boundingBox()]);
    return h && t ? { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y } : null;
  };
  await ringsAround(page, column(f.locator('th[data-device-header="name"]')));
  await goTo(page, 4);
  await expect(title(page)).toHaveText('LAN and WAN');
  await expect(spot(page)).toBeVisible();
  const [lan, wan] = await Promise.all([f.locator('th[data-device-group-header="lan"]').boundingBox(), f.locator('th[data-device-group-header="wan"]').boundingBox()]);
  // Both open groups are rung, from LAN's left edge to as much of WAN as can be seen.
  await expect.poll(async () => Math.abs((await spot(page).boundingBox())!.x + 5 - lan!.x), { timeout: 5000 }).toBeLessThan(2);
  const ring = (await spot(page).boundingBox())!;
  expect(ring.x + ring.width - 5).toBeGreaterThanOrEqual(Math.min(wan!.x + wan!.width, page.viewportSize()!.width) - 4);
  // Source on Camera Configuration is rung the same way, and its tag sits clear of the panel.
  await goTo(page, 7);
  const source = f.locator('[data-controller="__camera-setup__"] th[data-field-header="source"]');
  const setup = source.locator('xpath=ancestor::table[1]');
  await ringsAround(page, async () => {
    const [h, t] = await Promise.all([source.boundingBox(), setup.boundingBox()]);
    return h && t ? { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y } : null;
  });
  const [label, panel] = await Promise.all([tag(page).boundingBox(), card(page).boundingBox()]);
  expect(label!.y + label!.height).toBeLessThan(panel!.y);
  await expect(f.locator('.cv-tour-lines')).toBeVisible();
});

test('on a short window a column is scrolled clear of the panel, and leaving puts the page back', async ({ page, request }) => {
  await page.setViewportSize({ width: 1300, height: 560 });
  await open(page, request, true);
  const f = ui(page);
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await findRig(page);
  const tabPanel = f.locator('.hc-main > .hc-panel:not([hidden])');
  const before = await tabPanel.evaluate(el => el.scrollTop);
  await toggle(page).click();
  await goTo(page, 2);
  // The whole Name column is rung, scrolled above the panel to fit.
  const sheet = f.locator('[data-role="device-sheet"] table'), head = f.locator('th[data-device-header="name"]');
  await ringsAround(page, async () => {
    const [h, t] = await Promise.all([head.boundingBox(), sheet.boundingBox()]);
    return h && t ? { x: h.x, y: h.y, width: h.width, height: t.y + t.height - h.y } : null;
  });
  const [ring, panel] = await Promise.all([spot(page).boundingBox(), card(page).boundingBox()]);
  expect(ring!.y + ring!.height).toBeLessThanOrEqual(panel!.y);
  expect(await tabPanel.evaluate(el => el.scrollTop)).toBeGreaterThan(before);
  await card(page).getByRole('button', { name: 'Exit tour' }).click();
  await expect.poll(() => tabPanel.evaluate(el => el.scrollTop)).toBe(before);
});

test('the steps that happen in HubDash have nothing rung, and tick from keys and a press', async ({ page, request }) => {
  await open(page, request, false);
  await goTo(page, 12);
  await expect(title(page)).toHaveText('Add Cyanview actions');
  await expect(spot(page)).toBeHidden();
  await expect(tag(page)).toBeHidden();
  await expect(ui(page).locator('.cv-tour-lines')).toBeHidden();
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
  await expect(spot(page)).toBeVisible();
  await expect(f.locator('.cv-tour-lead')).toHaveCSS('animation-name', 'none');
  await expect(card(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  // The rung control works through the tour, and the tour stays where it was.
  await f.getByRole('button', { name: 'Network range', exact: true }).click();
  await f.getByRole('listbox', { name: 'Network range' }).getByRole('option', { name: '10.192.0.0/16', exact: true }).click();
  await expect(f.getByRole('button', { name: 'Network range', exact: true })).toContainText('10.192.0.0/16');
  await expect(title(page)).toHaveText('Discover');
});
