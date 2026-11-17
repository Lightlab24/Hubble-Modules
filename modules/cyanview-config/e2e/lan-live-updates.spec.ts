import { test, expect, type Page, type APIRequestContext, type FrameLocator } from '@playwright/test';

// A controller's held settings socket refreshes the page whenever anything changes on it, including
// while an address change waits to be sent or is being sent.
const ui = (page: Page) => page.frameLocator('iframe');
const sheet = (f: FrameLocator) => f.locator('[data-role="device-sheet"]');
const cell = (f: FrameLocator, id: string, field: string) => sheet(f).locator('[data-device-cell="' + id + ':' + field + '"]');
const panel = (f: FrameLocator) => f.locator('[data-role="pending-sends"]');
const RIO = 'CY-RIO-1-10';
type Lan = { id: string; device: string; elementKey?: string; current: string; planned: string; operation: string; dirty: string[] };
const rpcOf = (request: APIRequestContext) => async (commandId: string, value: unknown = null) => (await (await request.post('/__rpc', { data: { commandId, value } })).json()).result;
const savedLans = async (request: APIRequestContext) => ((await rpcOf(request)('read-plan')).plan.lans as Lan[]).filter(row => row.device === RIO);
const rioAddresses = async (request: APIRequestContext) => Object.values((await (await request.get('/__inspect')).json()).fleet[0].config.IP as Record<string, { IP: string }>).map(row => row.IP);

async function open(page: Page, request: APIRequestContext) {
  await request.post('/__reset', { data: { sample: false, remi: true, live: true } });
  await page.goto('/');
  const f = ui(page);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await f.locator('[data-action="refresh-all"]').click();
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.200/16');
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).openSockets).toEqual([1, 1, 1]);
  return f;
}
async function sendAll(f: FrameLocator) {
  if (await panel(f).isHidden()) await f.locator('#hc-devices .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await panel(f).locator('[data-action="send-all-pending"]').click();
}

test('a changed address keeps Replace through a live update, and its Send leaves one row', async ({ page, request }) => {
  const f = await open(page, request);
  await cell(f, RIO, 'lan1').fill('10.20.101.212');
  await cell(f, RIO, 'lan1').press('Enter');
  await expect.poll(async () => (await savedLans(request)).find(row => row.planned === '10.20.101.212/16')?.operation).toBe('Replace');

  // Something changes on the RIO from outside Hubble, and the page reads it in.
  await request.post('/__simulate', { data: { editCamera: { device: 0, key: 'wide', fields: { Name: 'Wide again' } } } });
  await expect.poll(async () => (await rpcOf(request)('read-plan')).plan.cameras.some((camera: { name: string }) => camera.name === 'Wide again')).toBe(true);
  await expect.poll(async () => (await savedLans(request)).find(row => row.planned === '10.20.101.212/16')?.operation).toBe('Replace');

  // The controller is slow to confirm the address, so its own report of the new element arrives first.
  await request.post('/__simulate', { data: { delayProperty: 'where', delayMs: 600 } });
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send', { timeout: 15000 });
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.212/16');
  expect(await rioAddresses(request)).toContain('10.20.101.212');
  expect(await rioAddresses(request)).not.toContain('10.20.101.200');
  await expect.poll(async () => {
    const keys = (await savedLans(request)).map(row => row.elementKey).filter(Boolean);
    return keys.length === new Set(keys).size && (await savedLans(request)).filter(row => row.current === '10.20.101.212/16').length;
  }).toBe(1);
});

test('an address change saved on Keep by an earlier version opens as Replace and sends', async ({ page, request }) => {
  const f = await open(page, request);
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await expect.poll(async () => (await (await request.get('/__inspect')).json()).planSavePending).toBe(0);
  const rpc = rpcOf(request), { revision, plan } = await rpc('read-plan');
  const row = (plan.lans as Lan[]).find(item => item.device === RIO && item.current === '10.20.101.200/16')!;
  Object.assign(row, { planned: '10.20.101.213/16', operation: 'Keep', dirty: ['planned'], pending: true, result: 'Pending' });
  // A copy of the same element, as a live update during a send used to leave behind.
  (plan.lans as Lan[]).push({ ...row, id: row.id + '-observed', planned: row.current, operation: 'Keep', dirty: [], pending: false, result: 'In sync' } as Lan);
  await rpc('save-plan', { revision, plan });
  await page.reload();
  await expect(cell(f, RIO, 'lan1')).toHaveValue('10.20.101.213/16');
  await sendAll(f);
  await expect(panel(f)).toContainText('Nothing is waiting to send', { timeout: 15000 });
  expect(await rioAddresses(request)).toContain('10.20.101.213');
  const keys = (await savedLans(request)).map(item => item.elementKey).filter(Boolean);
  expect(keys.length).toBe(new Set(keys).size);
});
