import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

// One part of the page in a window of its own (Nov 27, 2026). Right-click Cyanview in Hubble's sidebar, and Open in
// its own window › offers Devices, Camera Configuration, REMI Matrix, Firmware and Defaults. Hubble opens the page
// again with the part as its view, and the page shows only that part. The preview opens a part's window as
// /?view=<part>, and notes what the page asks of its window.
const frame = (page: Page) => page.frameLocator('iframe');
const rpc = async (request: APIRequestContext, commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const inspect = async (request: APIRequestContext) => (await request.get('/__inspect')).json();
const settled = async (request: APIRequestContext) => expect.poll(async () => (await inspect(request)).planSavePending).toBe(0);
const savedPlan = async (request: APIRequestContext) => (await rpc(request, 'read-plan')).plan;
const savedView = async (request: APIRequestContext) => (await rpc(request, 'page-view')).view;
const shownPanels = (f: FrameLocator) => f.locator('.hc-main > .hc-panel:not([hidden])');
const group = (f: FrameLocator, id: string) => f.locator('[data-controller="' + id + '"]');
const cameraCell = (f: FrameLocator, row: string) => group(f, 'rcp1').locator('[data-hubble-row="' + row + '"][data-hubble-column="name"]');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const pending = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');

const PARTS = [
  { view: 'devices', title: 'Devices', panel: 'hc-devices' },
  { view: 'setup', title: 'Camera Configuration', panel: 'hc-setup' },
  { view: 'assignment', title: 'REMI Matrix', panel: 'hc-assignment' },
  { view: 'firmware', title: 'Firmware', panel: 'hc-firmware' },
  { view: 'defaults', title: 'Defaults', panel: 'hc-defaults' },
] as const;

async function open(page: Page, view?: string) {
  await page.goto(view ? '/?view=' + view : '/');
  const f = frame(page);
  await expect(f.locator('#cyanview-design')).toBeVisible();
  // Sample data says so until the workspace has been saved once.
  await expect(f.locator('[data-role="saved-label"]')).toContainText(/Workspace saved|Sample data/);
  return f;
}
async function openSecond(page: Page, view?: string) {
  const second = await page.context().newPage();
  return { second, f: await open(second, view) };
}
/** Types a camera's name with real key presses on REMI Matrix by controller. */
async function rename(page: Page, f: FrameLocator, row: string, text: string) {
  const target = cameraCell(f, row);
  await target.dblclick();
  const editor = target.locator('input');
  await expect(editor).toHaveClass(/hc-cell-editing/);
  await editor.fill('');
  await page.keyboard.type(text);
  await editor.press('Enter');
}
async function byController(f: FrameLocator) {
  await f.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click();
  await expect(group(f, 'rcp1').getByRole('button', { name: 'Choose visible columns' })).toBeVisible();
}
/** Where a box is drawn in the page, in the page's own pixels. */
const box = async (target: Locator) => (await target.evaluate(element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; }));

test('each part opens alone in its window, under the header, with no tabs and no tour', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  // The whole page still has its tabs and the Setup tour.
  const whole = await open(page);
  await expect(whole.locator('.hc-tabs')).toBeVisible();
  await expect(whole.locator('.cv-setup-tour-toggle')).toBeVisible();
  for (const part of PARTS) {
    const { second, f } = await openSecond(page, part.view);
    await expect(f.locator('.hc-tabs')).toBeHidden();
    await expect(shownPanels(f)).toHaveCount(1);
    await expect(shownPanels(f)).toHaveAttribute('id', part.panel);
    // The tab the window shows is the part's own, as the hidden tab strip would name it.
    await expect(f.locator('.hc-tabs [aria-selected="true"]')).toContainText(part.title);
    await expect(f.locator('.hc-module-header [data-action="refresh-all"]')).toBeVisible();
    await expect(f.locator('.cv-setup-tour-toggle')).toBeHidden();
    await expect(f.locator('.cv-part-gone')).toBeHidden();
    // The part fills the room the tabs had, down to the footer.
    const header = await box(f.locator('.hc-module-header')), panel = await box(shownPanels(f)), foot = await box(f.locator('.hc-global-foot'));
    expect(Math.abs(panel.top - header.bottom), part.view + ' starts under the header').toBeLessThanOrEqual(1);
    expect(Math.abs(foot.top - panel.bottom), part.view + ' reaches the footer').toBeLessThanOrEqual(1);
    await second.close();
  }
  const seen = await inspect(request);
  expect(seen.windowRequests, 'no window asked for').toEqual([]);
  expect(seen.pageViewWrites, 'no part window saved where it is').toBe(0);
});

test('a part window never saves where it is, so the whole page opens where it was left', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  const whole = await open(page);
  await whole.locator('[data-tab="assignment"]').click();
  await expect.poll(async () => (await savedView(request))?.tab).toBe('assignment');
  await settled(request);
  const context = page.context();
  await page.close();
  const before = await inspect(request);

  // Where the part's window is: REMI Matrix by controller, a sort, another controller open, and Pending sends.
  const second = await context.newPage();
  const f = await open(second, 'assignment');
  await byController(f);
  await group(f, 'rcp1').locator('[data-sort-field="name"]').click();
  await expect(group(f, 'rcp1').locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort', 'ascending');
  await group(f, 'rcp2').locator('[data-action="toggle-controller"]').click();
  await expect(group(f, 'rcp2').locator('[data-action="toggle-controller"]')).toHaveAttribute('aria-expanded', 'true');
  await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(pending(f)).toBeVisible();
  await second.waitForTimeout(600);
  const after = await inspect(request);
  expect(after.pageViewWrites, 'no save of where the window is').toBe(before.pageViewWrites);
  expect(after.planSaves, 'no plan save for a view change').toBe(before.planSaves);
  const kept = await savedView(request);
  expect(kept.tab).toBe('assignment');
  expect(kept.remiView?.byController ?? false).toBe(false);
  expect(kept.remiView?.panelOpen ?? false).toBe(false);

  // The whole page opens where it was left, not where the part's window is.
  const { f: again } = await openSecond(second);
  await expect(again.locator('#hc-tab-assignment')).toHaveAttribute('aria-selected', 'true');
  await expect(again.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(pending(again)).toBeHidden();
});

test('edits in a part window show in the whole page, and the other way, without a reload', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  const whole = await open(page);
  await whole.locator('[data-tab="assignment"]').click();
  await byController(whole);
  await settled(request);
  const { second, f } = await openSecond(page, 'assignment');
  await byController(f);
  await rename(second, f, 'cam3', 'Part 3');
  await expect.poll(async () => (await savedPlan(request)).cameras.find((camera: { id: string }) => camera.id === 'cam3')?.name).toBe('Part 3');
  await expect(cameraCell(whole, 'cam3').locator('input')).toHaveValue('Part 3');
  await rename(page, whole, 'cam2', 'Whole 2');
  await expect.poll(async () => (await savedPlan(request)).cameras.find((camera: { id: string }) => camera.id === 'cam2')?.name).toBe('Whole 2');
  await expect(cameraCell(f, 'cam2').locator('input')).toHaveValue('Whole 2');
  await expect(cameraCell(f, 'cam3').locator('input')).toHaveValue('Part 3');
  // Neither moved: the part's window still shows only REMI Matrix, and the whole page keeps its tabs.
  await expect(f.locator('.hc-tabs')).toBeHidden();
  await expect(shownPanels(f)).toHaveAttribute('id', 'hc-cameras');
  await expect(whole.locator('.hc-tabs')).toBeVisible();
  await expect(whole.locator('#hc-tab-assignment')).toHaveAttribute('aria-selected', 'true');
  await expect(f.locator('[data-role="toast"]')).toBeHidden();
});

test('a link to another part opens that part in its own window, and this window stays on its part', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  const f = await open(page, 'devices');
  const link = f.locator('[data-action="open-defaults"]').first();
  await expect(link).toBeVisible();
  await link.click();
  await expect.poll(async () => (await inspect(request)).windowRequests).toEqual([{ operation: 'open-window', view: 'defaults', title: 'Defaults' }]);
  await expect(shownPanels(f)).toHaveCount(1);
  await expect(shownPanels(f)).toHaveAttribute('id', 'hc-devices');
  await expect(f.locator('.hc-tabs')).toBeHidden();
});

test('Pending sends lists and sends a change made in a part window', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: false, remi: true } });
  const f = await open(page, 'setup');
  const row = setup(f).locator('tbody tr[data-id]').first();
  const name = row.locator('[data-column="name"] input');
  await name.fill('Part wide');
  await name.press('Enter');
  await f.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(pending(f)).toBeVisible();
  // The list sits in the part this window shows.
  await expect(f.locator('#hc-setup [data-role="pending-sends"]')).toBeVisible();
  await expect(pending(f).locator('[data-pending-line]')).toHaveCount(1);
  await expect(pending(f).locator('[data-pending-line]')).toContainText('Part wide');
  await pending(f).locator('[data-action="send-all-pending"]').click();
  await expect(row.locator('[data-column="sync"]')).toHaveText('Verified', { timeout: 15000 });
  await expect(pending(f).locator('[data-pending-line]')).toHaveCount(0);
  expect((await inspect(request)).pageViewWrites).toBe(0);
});

test('a part this version no longer has says so', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  await page.goto('/?view=camera-3');
  const f = frame(page);
  await expect(f.locator('.cv-part-gone')).toHaveText('This part of the page is no longer here.');
  await expect(shownPanels(f)).toHaveCount(0);
  await expect(f.locator('.hc-tabs')).toBeHidden();
  await expect(f.locator('.hc-global-foot')).toBeVisible();
});

test('a plan saved before 0.1.112 keeps the whole page where it was when a part window saves first', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample: true } });
  // A saved workspace, with the whole page last on Devices.
  const first = await open(page);
  await first.locator('[data-tab="assignment"]').click();
  await byController(first);
  await rename(page, first, 'cam2', 'Saved 2');
  await expect.poll(async () => (await savedPlan(request))?.cameras.find((camera: { id: string }) => camera.id === 'cam2')?.name).toBe('Saved 2');
  await first.locator('.hc-panel:not([hidden]) [data-remi-view="matrix"]').click();
  await first.locator('[data-tab="devices"]').click();
  await expect.poll(async () => (await savedView(request))?.tab).toBe('devices');
  await settled(request);
  const context = page.context();
  await page.close();
  // Then 0.1.111 saved it, with where its page was left: REMI Matrix by controller.
  let read = await rpc(request, 'read-plan');
  const plan = read.plan;
  plan.uiState.privateContent.tab = 'assignment';
  plan.uiState.privateContent.remiView = { ...(plan.uiState.privateContent.remiView ?? {}), byController: true };
  for (let attempt = 0; attempt < 5 && !(await rpc(request, 'save-plan', { revision: read.revision, plan }))?.revision; attempt++) read = await rpc(request, 'read-plan');
  expect((await savedPlan(request)).uiState.privateContent.tab).toBe('assignment');
  // A part's window opens first, and its first edit saves the plan without that place.
  const second = await context.newPage();
  const f = await open(second, 'assignment');
  await expect(shownPanels(f)).toHaveAttribute('id', 'hc-cameras');
  await rename(second, f, 'cam3', 'Part 3');
  await expect.poll(async () => (await savedPlan(request)).cameras.find((camera: { id: string }) => camera.id === 'cam3')?.name).toBe('Part 3');
  await settled(request);
  expect((await savedPlan(request)).uiState.privateContent.tab).toBeUndefined();
  // The whole page still opens where 0.1.111 left it.
  expect((await savedView(request))?.tab).toBe('assignment');
  const { f: whole } = await openSecond(second);
  await expect(whole.locator('#hc-tab-assignment')).toHaveAttribute('aria-selected', 'true');
  await expect(whole.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]')).toHaveAttribute('aria-pressed', 'true');
});
