import { test, expect, type Page, type APIRequestContext, type FrameLocator, type Locator } from '@playwright/test';

const ui = (page: Page) => page.frameLocator('iframe');
const setup = (f: FrameLocator) => f.locator('[data-controller="__camera-setup__"]');
const named = (f: FrameLocator, name: string) => setup(f).locator('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])');
const cell = (r: Locator, column: string) => r.locator('[data-column="' + column + '"]');
const mark = (r: Locator) => r.locator('td.hc-camera-row-gutter .hc-conflict-mark');
const chip = (f: FrameLocator) => f.locator('#hc-setup .hc-conflict-chip');
const list = (f: FrameLocator) => f.locator('#hc-number-conflicts');
const RIO = 'CY-RIO-1-10', MASTER = 'CY-RCP-1-20';
const rpcOf = (request: APIRequestContext) => async (commandId: string, value?: unknown) =>
  (await (await request.post('/__rpc', { data: { commandId, ...(value === undefined ? {} : { value }) } })).json()).result;

/** Master RCP has Jib, its own camera 7. `copy` puts a copy of Stage RIO's Wide beside it under the same number. */
async function open(page: Page, request: APIRequestContext, copy: boolean) {
  await request.post('/__reset', { data: { sample: false, remi: true, direct: true } });
  if (copy) {
    const rpc = rpcOf(request), saved = await rpc('read-plan'), plan = saved.plan;
    const wide = plan.cameras.find((camera: { name: string }) => camera.name === 'Wide');
    plan.cameras.push({ ...wide, id: MASTER + ':camera:copy', device: MASTER, elementKey: 'copy', number: '7', model: 'Cyan - Imported', modelLabel: 'Cyan - Imported',
      remi: { peer: RIO.toLowerCase(), sourceKey: wide.elementKey, label: '1 Wide', origin: { serial: RIO, model: 'Venice-IP' } } });
    expect((await rpc('save-plan', { revision: saved.revision, plan }))?.revision).toBeTruthy();
  }
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-tab="setup"]').click();
  await expect(setup(f).locator('table[role="grid"]')).toBeVisible();
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  return f;
}
/** Where the things a warning must never push are: the title, the first heading, Pending sends and the two cameras' rows. */
const places = (f: FrameLocator) => f.locator('#hc-setup').evaluate(panel => {
  const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height].map(Math.round).join(',') : 'none'; };
  return [box(panel.querySelector('.hc-toolbar-title h3')), box(panel.querySelector('.hc-sort-heading')), box(panel.querySelector('.hc-toolbar [data-action="toggle-pending-sends"]')),
    ...['Wide', 'Jib'].flatMap(name => { const row = panel.querySelector('tbody tr[data-id]:has(input[data-field="name"][value="' + name + '"])'); return [box(row), box(row?.querySelector('input[data-field="number"]') ?? null)]; })].join(' | ');
});
async function typeNumber(r: Locator, value: string) {
  await cell(r, 'number').locator('input').fill(value);
  await cell(r, 'number').locator('input').press('Enter');
}

test('a number a controller has twice is marked on its rows, counted on a chip and listed, and nothing moves', async ({ page, request }) => {
  const f = await open(page, request, true);
  await expect(chip(f)).toBeVisible();
  await expect(chip(f)).toHaveText('1 number used twice');
  const tip = 'Master RCP has two cameras numbered 7: Jib, its own, and Wide, copied from Stage RIO. Keys for camera 7 on Master RCP use Jib.';
  // The copy is folded into Wide's row, so that row carries the mark for it.
  for (const name of ['Jib', 'Wide']) await expect(mark(named(f, name))).toHaveAttribute('data-tip', tip);
  await expect(setup(f).locator('.hc-conflict-mark')).toHaveCount(2);
  await mark(named(f, 'Jib')).hover();
  await expect(f.locator('#hc-quick-tip')).toBeVisible();
  await expect(f.locator('#hc-quick-tip')).toHaveText(tip);
  await page.mouse.move(5, 5);

  const before = await places(f);
  await chip(f).click();
  await expect(list(f)).toBeVisible();
  await expect(chip(f)).toHaveAttribute('aria-expanded', 'true');
  await expect(list(f)).toContainText('Camera 7 on Master RCP');
  await expect(list(f).locator('li')).toHaveText(['Jibits own camera', 'Widecopied from Stage RIO']);
  await expect(list(f)).toContainText('Keys for camera 7 on Master RCP use Jib. Renumber or remove one to clear this.');
  expect(await places(f)).toBe(before);
  // It floats under the chip, with their right edges together.
  const chipBox = (await chip(f).boundingBox())!, listBox = (await list(f).boundingBox())!;
  expect(Math.abs(chipBox.x + chipBox.width - (listBox.x + listBox.width))).toBeLessThanOrEqual(1);
  expect(listBox.y).toBeGreaterThan(chipBox.y + chipBox.height);

  // Escape from it, a click elsewhere, and Pending sends opening each put it away.
  await chip(f).press('Escape');
  await expect(list(f)).toBeHidden();
  await chip(f).click();
  await cell(named(f, 'Wide'), 'name').click();
  await expect(list(f)).toBeHidden();
  await chip(f).click();
  await f.locator('#hc-setup .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(list(f)).toBeHidden();
  await expect(f.locator('[data-role="pending-sends"]')).toBeVisible();
  await chip(f).click();
  await expect(f.locator('[data-role="pending-sends"]')).toBeHidden();
  await expect(list(f)).toBeVisible();
  await list(f).getByRole('button', { name: 'Close numbers used twice' }).click();
  await expect(list(f)).toBeHidden();

  // No other tab carries the marks.
  await f.locator('[data-tab="assignment"]').click();
  await expect(f.locator('.hc-conflict-mark:visible')).toHaveCount(0);
});

test('typing a number another camera on the same controller has brings the warning, and typing it back takes it away', async ({ page, request }) => {
  const f = await open(page, request, false);
  await expect(chip(f)).toBeHidden();
  await expect(setup(f).locator('.hc-conflict-mark')).toHaveCount(0);
  // A second camera of Master RCP's own, given Jib's number.
  const known = await setup(f).locator('tbody tr[data-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id));
  await f.locator('#hc-setup').getByRole('button', { name: 'One camera more' }).click();
  await expect(setup(f).locator('tbody tr[data-id]')).toHaveCount(known.length + 1);
  const id = (await setup(f).locator('tbody tr[data-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id))).find(item => !known.includes(item))!;
  const added = setup(f).locator('tbody tr[data-id="' + id + '"]');
  await cell(added, 'source').click();
  await setup(f).locator('table[role="grid"]').press('Enter');
  await f.getByRole('dialog').getByRole('option', { name: 'Master RCP', exact: true }).click();
  await typeNumber(added, '9');
  await expect(chip(f)).toBeHidden();
  const before = await places(f);
  await typeNumber(added, '7');
  await expect(chip(f)).toHaveText('1 number used twice');
  await expect(setup(f).locator('.hc-conflict-mark')).toHaveCount(2);
  await expect(mark(named(f, 'Jib'))).toHaveAttribute('data-tip', /Master RCP has two cameras numbered 7: .*Keys for camera 7 on Master RCP act on .* and .* together\./);
  // The chip coming and going leaves the title, the headings, Pending sends and the rows where they were.
  expect(await places(f)).toBe(before);
  await typeNumber(added, '9');
  await expect(chip(f)).toBeHidden();
  await expect(setup(f).locator('.hc-conflict-mark')).toHaveCount(0);
  expect(await places(f)).toBe(before);
});
