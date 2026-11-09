import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test';
const ui = (page: Page) => page.frameLocator('iframe');
const gridCell = (control: Locator) => control.locator('..');
const grid = (cell: Locator) => cell.locator('xpath=ancestor::table');
async function selectCameraCell(control: Locator) {
  const cell = gridCell(control);
  await expect(grid(cell)).toHaveAttribute('tabindex', '0');
  await cell.click();
  return grid(cell);
}
async function chooseCameraCell(frame: ReturnType<typeof ui>, cell: Locator, label: string) {
  const sheet = await selectCameraCell(cell);
  await sheet.press('Enter');
  await frame.getByRole('dialog').getByRole('option', { name: label, exact: true }).click();
}
async function open(page: Page, request: APIRequestContext, sample = true) {
  await request.post('/__reset', { data: { sample } });
  await page.goto('/'); await expect(ui(page).locator('#cyanview-design')).toBeVisible();
  await expect(ui(page).locator('[data-role="saved-label"]')).toContainText(sample ? 'Sample data' : 'Workspace saved');
  if (sample) await ui(page).locator('[data-tab="cameras"]').click();
}
async function inspect(request: APIRequestContext) { return (await request.get('/__inspect')).json(); }
async function saved(request: APIRequestContext) {
  const reply = await request.post('/__rpc', { data: { operation: 'call', commandId: 'read-plan', value: null } });
  return (await reply.json()).result.plan;
}

test('camera deletion targets the active cell or the right-clicked row after confirmation', async ({ page, request }) => {
  const errors: string[] = [], sends: any[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => {
    if (value.url().endsWith('/__rpc') && value.method() === 'POST') {
      const payload = value.postDataJSON(); if (payload?.commandId === 'send') sends.push(payload.value);
    }
  });
  await open(page, request, false); const f = ui(page);
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), rows = group.locator('tr[data-id]');
  const deleteButton = group.locator('[data-action="delete-controller"]');
  await expect(deleteButton).toBeDisabled();
  for (let number = 1; number <= 3; number++) await group.locator('[data-new-camera]').selectOption('Alpha-USB');
  await expect(rows).toHaveCount(3);
  await expect(group.getByRole('grid').getByRole('checkbox', { name: /Camera Control Enabled/ })).toHaveCount(3);
  await request.post('/__simulate', { data: { holdAction: 'new' } });
  await group.locator('[data-action="send-controller"]').click();
  await expect.poll(async () => (await inspect(request)).heldReplies).toBe(3);
  expect(sends).toHaveLength(1); expect(sends[0].items).toHaveLength(3);
  expect((await inspect(request)).actions.filter((action: any) => action.new)).toHaveLength(3);
  await expect(group.locator('tr[data-id] [data-column="sync"]')).toHaveText(['Sending', 'Sending', 'Sending']);
  await request.post('/__simulate', { data: { releaseReplies: true } });
  await expect(group.locator('tr[data-id] [data-column="sync"]')).toHaveText(['Verified', 'Verified', 'Verified']);

  const sheet = await selectCameraCell(rows.nth(1).locator('[data-field="name"]'));
  await sheet.press('Shift+ArrowDown');
  await expect(rows.locator('[data-hubble-spreadsheet-selected]')).toHaveCount(2);
  await expect(deleteButton).toHaveText('Delete camera 2');
  await deleteButton.click();
  const dialog = f.getByRole('dialog', { name: 'Delete camera from device' });
  await expect(dialog).toContainText('Camera 2');
  expect(sends).toHaveLength(1);
  await request.post('/__simulate', { data: { holdAction: 'delete' } });
  await dialog.getByRole('button', { name: 'Delete camera', exact: true }).click();
  await expect.poll(async () => (await inspect(request)).heldReplies).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[1].items).toMatchObject([{ deleting: true, item: { number: '2' } }]);
  await request.post('/__simulate', { data: { releaseReplies: true } });
  await expect(rows).toHaveCount(2);
  await expect(deleteButton).toBeDisabled();

  await selectCameraCell(rows.first().locator('[data-field="name"]'));
  await expect(deleteButton).toHaveText('Delete camera 1');
  const rightClick = rows.last().locator('[data-column="name"]');
  const menuItem = f.getByRole('menuitem', { name: 'Delete camera', exact: true });
  await rightClick.click({ button: 'right' });
  await menuItem.click();
  await expect(dialog).toContainText('Camera 3');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(sends).toHaveLength(2);
  await rightClick.click({ button: 'right' });
  await menuItem.click();
  await request.post('/__simulate', { data: { holdAction: '' } });
  await dialog.getByRole('button', { name: 'Delete camera', exact: true }).click();
  await expect(rows).toHaveCount(1);
  expect(sends[2].items).toMatchObject([{ deleting: true, item: { number: '3' } }]);
  await expect.poll(async () => (await saved(request))?.cameras?.map((row: any) => row.number)).toEqual(['1']);
  expect(errors).toEqual([]);
});

test('auto sends and deletions on different cameras proceed while earlier replies are held', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, request, false); const f = ui(page);
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), rows = group.locator('tr[data-id]');
  for (let number = 1; number <= 3; number++) await group.locator('[data-new-camera]').selectOption('Alpha-USB');
  await group.locator('[data-action="send-controller"]').click();
  await expect(rows.locator('[data-column="sync"]')).toHaveText(['Verified', 'Verified', 'Verified']);
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await request.post('/__simulate', { data: { holdAction: 'update' } });
  await rows.nth(0).locator('[data-field="name"]').fill('First auto edit');
  await rows.nth(0).locator('[data-field="name"]').press('Enter');
  await expect.poll(async () => (await inspect(request)).heldReplies).toBe(1);
  await rows.nth(1).locator('[data-field="name"]').fill('Second auto edit');
  await rows.nth(1).locator('[data-field="name"]').press('Enter');
  await expect.poll(async () => (await inspect(request)).heldReplies).toBe(2);
  await selectCameraCell(rows.nth(2).locator('[data-field="name"]'));
  await group.locator('[data-action="delete-controller"]').click();
  await f.locator('[data-action="confirm-send"]').click();
  await expect(rows).toHaveCount(2);
  expect((await inspect(request)).heldReplies).toBe(2);
  await request.post('/__simulate', { data: { releaseReplies: true } });
  await expect(rows.locator('[data-column="sync"]')).toHaveText(['Verified', 'Verified']);
  await request.post('/__simulate', { data: { holdAction: 'delete' } });
  await selectCameraCell(rows.nth(0).locator('[data-field="name"]'));
  await group.locator('[data-action="delete-controller"]').click();
  await f.locator('[data-action="confirm-send"]').click();
  await expect.poll(async () => (await inspect(request)).heldReplies).toBe(1);
  await expect(rows.nth(0).locator('[data-field="name"]')).toBeDisabled();
  await rows.nth(1).locator('[data-field="name"]').fill('Edited during another deletion');
  await rows.nth(1).locator('[data-field="name"]').press('Enter');
  await expect(rows.nth(1).locator('[data-column="sync"]')).toHaveText('Verified');
  expect((await inspect(request)).heldReplies).toBe(1);
  await request.post('/__simulate', { data: { releaseReplies: true } });
  await expect(rows).toHaveCount(1);
  await expect.poll(async () => (await saved(request))?.cameras?.map((row: any) => row.name)).toEqual(['Edited during another deletion']);
  await page.reload();
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('[data-field="name"]')).toHaveValue('Edited during another deletion');
  expect(errors).toEqual([]);
});

test('the grouped sheet distinguishes unavailable axis setup from unchecked controls', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, request);
  const f = ui(page), group = f.locator('[data-controller="rcp1"]');
  await expect(f.locator('[data-controller]')).toHaveCount(5);
  await expect(group.locator('[data-field="login"]').first()).toHaveValue('admin');
  await expect(group.locator('[data-field="password"]').first()).toHaveValue('demo');
  expect(await group.locator('[data-field="password"]').first().getAttribute('type')).not.toBe('password');
  await expect(group.getByRole('button', { name: 'Expand Iris', exact: true })).toBeVisible();
  await group.locator('.hc-sheet').screenshot({ path: 'artifacts/cyanview-module-ui.png' });

  const sheet = group.getByRole('grid');
  // Clicking a header can scroll the sheet, and a frozen column's offset follows the scroll, so compare from the same position.
  const earlierColumns = async () => {
    await group.locator('.hc-scroll').evaluate(scroll => { scroll.scrollLeft = 0; });
    return sheet.locator('tbody tr').first().locator('td:is([data-column="name"], [data-column="lens"])')
      .evaluateAll(cells => cells.map(cell => [(cell as HTMLElement).offsetLeft, (cell as HTMLElement).offsetWidth]));
  };
  const collapsedWidth = await sheet.evaluate(element => (element as HTMLElement).offsetWidth);
  const originalColumns = await earlierColumns();
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  expect(await earlierColumns()).toEqual(originalColumns);
  expect(await sheet.evaluate(element => (element as HTMLElement).offsetWidth)).toBeGreaterThan(collapsedWidth);
  await group.getByRole('button', { name: 'Collapse Iris', exact: true }).click();
  expect(await sheet.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(collapsedWidth);
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await group.getByRole('button', { name: 'Expand Zoom', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Expand Focus', exact: true })).toBeVisible();
  let row = group.locator('tr[data-id="cam1"]');
  await expect(group.locator('th[data-field-header="irisSummary"]')).toHaveText('Use Iris');
  const setup = row.locator('[data-column="irisSummary"]');
  await expect(setup).toHaveText('—');
  await expect(setup.getByRole('checkbox')).toHaveCount(0);
  await setup.click();
  await expect(group.locator('[data-camera-location]')).toHaveText('Camera 1 · Use Iris');
  await expect(group.locator('[data-camera-value]')).toHaveText('Unavailable for this camera');
  await expect(row.locator('[data-field="irisMotor"]')).toBeDisabled();
  await expect(row.locator('[data-field="irisMotor"]')).toHaveValue('');
  await expect(row.locator('[data-field="irisTorque"]')).toHaveAttribute('value', '');
  await chooseCameraCell(f, row.locator('[data-field="lens"]'), 'ARRI - cforce');
  row = group.locator('tr[data-id="cam1"]');
  const iris = row.locator('[data-lens-axis="iris"] [role="checkbox"]');
  await expect(iris).not.toBeChecked();
  await expect(setup).toHaveText('');
  await expect(row.locator('[data-field="irisTorque"]')).toBeDisabled();
  await iris.check();
  await chooseCameraCell(f, row.locator('[data-field="irisTorque"]'), '4');
  await chooseCameraCell(f, row.locator('[data-field="lens"]'), 'Tilta - Nucleus-M');
  await expect(row.locator('[data-field="irisTorque"]')).toBeDisabled();
  await expect(row.locator('[data-field="irisTorque"]')).toHaveAttribute('value', '');
  await expect(row.locator('[data-field="irisMotor"]')).toHaveValue('');
  await chooseCameraCell(f, row.locator('[data-field="lens"]'), 'ARRI - cforce');
  await expect(row.locator('[data-field="irisTorque"]')).toHaveAttribute('value', '4');
  await group.getByRole('button', { name: 'Choose visible columns', exact: true }).click();
  await f.getByRole('searchbox', { name: 'Search columns' }).fill('Username');
  await f.getByRole('menuitemcheckbox', { name: 'Username', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(group.locator('td[data-column="login"]')).toHaveCount(0);
  await expect(group.locator('td[data-column="password"]')).toHaveCount(4);
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.hiddenCameraColumnsByDevice?.rcp1).toContain('login');
  await page.reload();
  await expect(group.getByRole('button', { name: 'Collapse Iris', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Collapse Zoom', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Expand Focus', exact: true })).toBeVisible();
  await expect(group.locator('td[data-column="login"]')).toHaveCount(0);
  await expect(group.locator('tr[data-id="cam1"] [data-field="irisTorque"]')).toHaveAttribute('value', '4');
  await group.locator('.hc-sheet').screenshot({ path: 'artifacts/cyanview-module-approved-ui.png' });
  expect((await inspect(request)).actions).toHaveLength(0); expect(errors).toEqual([]);
});

test('Patch Sheet saves camera column widths, row heights and collapsed fields', async ({ page, request }) => {
  await open(page, request);
  const f = ui(page), group = f.locator('[data-controller="rcp1"]');
  const column = group.locator('th[data-field-header="name"]');
  const row = group.locator('tr[data-id="cam1"]');
  const width = await column.evaluate(element => (element as HTMLElement).offsetWidth);
  const height = await row.evaluate(element => (element as HTMLElement).offsetHeight);
  const columnHandle = f.getByRole('separator', { name: 'Resize Camera name', exact: true });
  await expect(columnHandle).toBeVisible();
  const edge = (await columnHandle.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 36, edge.y + edge.height / 2, { steps: 5 });
  await page.mouse.up();
  await f.getByRole('separator', { name: 'Resize camera 1 row', exact: true }).press('ArrowDown');
  await expect.poll(() => column.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(width + 36);
  await expect.poll(() => row.evaluate(element => (element as HTMLElement).offsetHeight)).toBe(height + 10);
  const iris = group.getByRole('button', { name: 'Expand Iris', exact: true });
  await iris.click({ button: 'right' });
  await f.getByRole('menuitem', { name: /Collapsed fields/ }).press('ArrowRight');
  const torque = f.getByRole('menuitemcheckbox', { name: 'Torque', exact: true });
  await torque.click();
  await expect(torque).toHaveAttribute('aria-checked', 'true');
  await expect(row.locator('[data-column="irisTorque"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.cameraLayouts?.rcp1).toMatchObject({
    columns: { name: width + 36 },
    rows: { cam1: height + 10 },
    groups: { iris: { collapsed: ['irisTorque'] } },
  });
  await page.reload();
  await expect.poll(() => column.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(width + 36);
  await expect.poll(() => row.evaluate(element => (element as HTMLElement).offsetHeight)).toBe(height + 10);
  await expect(iris).toBeVisible();
  await expect(row.locator('[data-column="irisTorque"]')).toBeVisible();
  expect((await inspect(request)).actions).toHaveLength(0);
});

test('each camera opts into lens axes and only sends the selected settings', async ({ page, request }) => {
  await open(page, request, false);
  const f = ui(page);
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), rows = group.locator('tr[data-id]');
  const first = rows.first(), second = rows.nth(1);
  const send = group.locator('[data-action="send-controller"]');
  await group.getByRole('button', { name: 'Choose visible columns' }).click();
  await f.getByRole('searchbox', { name: 'Search columns' }).fill('Use');
  for (const axis of ['Iris', 'Zoom', 'Focus']) await f.getByRole('menuitemcheckbox', { name: 'Use ' + axis, exact: true }).click();
  await f.getByRole('searchbox', { name: 'Search columns' }).press('Escape');
  for (const row of [first, second]) {
    await group.locator('[data-new-camera]').selectOption('Alpha-USB');
    await chooseCameraCell(f, row.locator('[data-field="lens"]'), 'Tilta - Nucleus-M');
    for (const axis of ['iris', 'zoom', 'focus']) await expect(row.locator('[data-lens-axis="' + axis + '"] [role="checkbox"]')).not.toBeChecked();
  }
  await send.click();
  await expect(rows.locator('[data-column="sync"]')).toHaveText(['Verified', 'Verified']);
  const params = async () => Object.values((await inspect(request)).config.Camera)
    .sort((a: any, b: any) => Number(a.Number) - Number(b.Number))
    .map((camera: any) => camera.LensParams);
  expect(await params()).toEqual(['', '']);

  const enter = async (name: string, value: string) => { await first.locator('[data-field="' + name + '"]').fill(value); await first.locator('[data-field="' + name + '"]').press('Enter'); };
  await first.locator('[data-lens-axis="iris"] [role="checkbox"]').check();
  await expect(second.locator('[data-lens-axis="iris"] [role="checkbox"]')).not.toBeChecked();
  await group.getByRole('button', { name: 'Expand Iris', exact: true }).click();
  await expect(first.locator('[data-field="irisMotor"]')).toHaveValue('');
  await enter('irisMotor', '3'); await enter('irisMin', '1.6'); await enter('irisMax', '32');
  await send.click();
  await expect(first.locator('[data-column="sync"]')).toHaveText('Verified');
  expect(await params()).toEqual(['3:I:1.6:32', '']);

  await first.locator('[data-lens-axis="iris"] [role="checkbox"]').uncheck();
  await first.locator('[data-lens-axis="zoom"] [role="checkbox"]').check();
  await group.getByRole('button', { name: 'Expand Zoom', exact: true }).click();
  await enter('zoomMotor', '5');
  await first.locator('[data-lens-axis="focus"] [role="checkbox"]').check();
  await group.getByRole('button', { name: 'Expand Focus', exact: true }).click();
  await first.locator('[data-field="focusMotor"]').fill('8');
  await first.locator('[data-field="focusMotor"]').press('Enter');
  await first.locator('[data-lens-axis="focus"] [role="checkbox"]').uncheck();
  await expect(first.locator('[data-field="focusMotor"]')).toBeDisabled();
  await expect(first.locator('[data-field="focusMotor"]')).toHaveValue('');
  await send.click();
  await expect(first.locator('[data-column="sync"]')).toHaveText('Verified');
  expect(await params()).toEqual(['3:I:1.6:32,5:Z', '']);
  await expect.poll(async () => (await saved(request))?.cameras?.[0]?.enabledLensAxes).toEqual(['zoom']);
  await page.reload();
  await expect(first.locator('[data-lens-axis="iris"] [role="checkbox"]')).not.toBeChecked();
  await expect(first.locator('[data-lens-axis="zoom"] [role="checkbox"]')).toBeChecked();
  await expect(first.locator('[data-lens-axis="focus"] [role="checkbox"]')).not.toBeChecked();
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await first.locator('[data-lens-axis="focus"] [role="checkbox"]').check();
  await expect(first.locator('[data-field="focusMotor"]')).toHaveValue('8');
  await expect(first.locator('[data-column="sync"]')).toHaveText('Verified');
  expect(await params()).toEqual(['3:I:1.6:32,5:Z,8:F', '']);
});

test('mixed device order, expand all and LAN columns retain the approved interactions', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, request); const f = ui(page);
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  await expect(f.locator('[data-action="toggle-controller"][aria-expanded="true"]')).toHaveCount(5);
  await f.locator('[data-controller="rio1"] [data-reorder-handle="rio1"]').focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => f.locator('[data-controller]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.controller))).toEqual(['rcp1', 'rio1', 'rcp2', 'rio2', 'rio3']);
  await f.getByRole('button', { name: 'Collapse all device spreadsheets', exact: true }).click();
  await expect(f.locator('[data-action="toggle-controller"][aria-expanded="true"]')).toHaveCount(0);
  await f.locator('[data-tab="devices"]').click();
  const network=f.locator('[data-network-controller="rcp1"]');
  await expect(f.locator('[data-network-controller]')).toHaveCount(5);
  await expect(f.locator('[data-tab="discovery"]')).toHaveCount(0);
  await network.locator('[data-action="network-columns"]').click();
  await network.getByRole('checkbox', { name: 'Show Current address', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await expect(network.locator('[data-network-columns-for]')).toBeHidden();
  await expect(network.locator('td[data-column="current"]')).toHaveCount(0);
  await f.getByRole('button', { name: 'Expand all device settings', exact: true }).click();
  await expect(f.locator('[data-action="toggle-network-device"][aria-expanded="true"]')).toHaveCount(5);
  await expect(f.locator('[data-network-controller="rio1"] td[data-column="current"]').first()).toBeVisible();
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.hiddenNetworkColumnsByDevice?.rcp1).toContain('current');
  await page.reload(); await expect(network.getByRole('table')).toBeVisible();
  await expect(network.locator('td[data-column="current"]')).toHaveCount(0);
  await f.locator('[data-tab="cameras"]').click();
  await expect(f.locator('[data-action="toggle-controller"][aria-expanded="true"]')).toHaveCount(0);
  expect(await f.locator('[data-controller]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.controller))).toEqual(['rcp1', 'rio1', 'rcp2', 'rio2', 'rio3']);
  expect(errors).toEqual([]); expect((await inspect(request)).actions).toHaveLength(0);
});

test('live bridge discovers, explicitly adds, saves and sends to the simulated controller', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await open(page, request, false); const f = ui(page);
  await expect(f.locator('[data-controller]')).toHaveCount(0);
  await expect(f.locator('[data-role="device-discovery"]')).toHaveAttribute('open','');
  await expect(f.locator('[data-action="scan"]')).toBeDisabled();
  await f.getByRole('combobox', { name: 'Network range', exact: true }).selectOption('custom');
  await f.getByRole('textbox', { name: 'Custom CIDR range', exact: true }).fill('10.20.101.200/32');
  await f.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(f.getByRole('table', { name: 'Discovered devices' }).locator('tbody tr')).toHaveCount(1);
  await expect(f.locator('[data-action="add-discovered"]')).toBeDisabled();
  await f.getByRole('textbox', { name: 'Device IP address', exact: true }).fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.getByRole('table', { name: 'Discovered devices' }).locator('tbody tr')).toHaveCount(1);
  await expect(f.locator('[data-role="device-count"]')).toHaveText('0');
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  expect((await inspect(request)).actions).toHaveLength(0);
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]');
  await group.locator('[data-new-camera]').selectOption('Venice-IP');
  const row = group.locator('tr[data-id]').first();
  await row.locator('[data-field="name"]').fill('Studio Camera'); await row.locator('[data-field="name"]').press('Enter');
  await row.locator('[data-field="ip"]').fill('10.20.100.101'); await row.locator('[data-field="ip"]').press('Tab');
  await row.locator('[data-field="login"]').fill('operator'); await row.locator('[data-field="login"]').press('Tab');
  await row.locator('[data-field="password"]').fill('preview-password'); await row.locator('[data-field="password"]').press('Enter');
  expect((await inspect(request)).actions).toHaveLength(0);
  await request.post('/__simulate', { data: { delayProperty: 'password', delayMs: 500 } });
  await group.locator('[data-action="send-controller"]').click();
  await expect.poll(async () => (await inspect(request)).actions.some((action: any) => action.update?.changes?.password === 'preview-password')).toBe(true);
  await row.locator('[data-field="password"]').fill('edited-during-send');
  await row.locator('[data-field="password"]').press('Enter');
  const passwordCell = row.locator('[data-column="password"]');
  await expect(passwordCell).toHaveCSS('background-color', 'rgb(51, 44, 30)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(passwordCell).toHaveCSS('background-color', 'rgb(255, 244, 217)');
  await expect(row.locator('[data-column="sync"]')).toContainText('Pending');
  await expect.poll(async () => Object.values((await inspect(request)).config.Camera)[0]).toMatchObject({ Name: 'Studio Camera', IP: '10.20.100.101', Login: 'operator', Password: 'preview-password' });
  await expect(group.locator('[data-action="send-controller"]')).toBeEnabled();
  await request.post('/__simulate', { data: { delayMs: 0 } });
  await group.locator('[data-action="send-controller"]').click();
  await expect(row.locator('[data-column="sync"]')).toContainText('Verified');
  expect((Object.values((await inspect(request)).config.Camera)[0] as any).Password).toBe('edited-during-send');
  await expect(passwordCell).not.toHaveClass(/hc-changed/);
  // Switching modes never flushes a previously committed draft.
  await row.locator('[data-field="name"]').fill('Staged name'); await row.locator('[data-field="name"]').press('Enter');
  const before = (await inspect(request)).actions.length;
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await expect.poll(async () => (await saved(request))?.uiState?.privateContent?.ui?.sendMode).toBe('Auto send');
  expect((await inspect(request)).actions).toHaveLength(before);
  // Intermediate keystrokes stay local; Enter sends only that committed field.
  await row.locator('[data-field="password"]').fill('auto-password');
  expect((await inspect(request)).actions).toHaveLength(before);
  await row.locator('[data-field="password"]').press('Enter');
  await expect.poll(async () => (Object.values((await inspect(request)).config.Camera)[0] as any).Password).toBe('auto-password');
  expect((Object.values((await inspect(request)).config.Camera)[0] as any).Name).toBe('Studio Camera');
  await expect.poll(async () => (await saved(request))?.cameras?.[0]?.password).toBe('auto-password');
  await page.reload();
  await expect(f.locator('tr[data-id] [data-field="password"]').first()).toHaveValue('auto-password');
  await expect(f.locator('tr[data-id] [data-field="name"]').first()).toHaveValue('Staged name');
  const restarted = (await inspect(request)).actions.length;
  await f.getByRole('button', { name: 'Refresh all', exact: true }).click();
  await expect(f.locator('[data-role="toast"]')).toHaveText('Settings refreshed · edits retained');
  expect((await inspect(request)).actions).toHaveLength(restarted);
  expect(errors).toEqual([]);
});

test('Find by IP stays visible through completed scans and repeated host state updates',async({page,request})=>{
  await open(page,request,false);const f=ui(page);
  await expect(f.locator('[data-tab="devices"]')).toHaveAttribute('aria-selected','true');
  await f.getByRole('combobox',{name:'Network range',exact:true}).selectOption('custom');
  await f.getByRole('textbox',{name:'Custom CIDR range',exact:true}).fill('10.20.101.250/32');
  await f.getByRole('button',{name:'Discover',exact:true}).click();
  await expect(f.locator('[data-role="scan-label"]')).toContainText('Discovery complete');
  await f.getByRole('textbox',{name:'Device IP address',exact:true}).fill('10.192.1.10');
  await f.getByRole('button',{name:'Find',exact:true}).click();
  const rows=f.getByRole('table',{name:'Discovered devices'}).locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await f.getByRole('combobox',{name:'Discovery method',exact:true}).selectOption('ip');
  await f.getByRole('button',{name:'Discover',exact:true}).click();
  await expect(f.locator('[data-role="scan-label"]')).toContainText('IP scan complete');
  await f.getByRole('button',{name:'Refresh all',exact:true}).click();
  await expect(f.locator('[data-role="toast"]')).toHaveText('Settings refreshed · edits retained');
  await expect(rows).toHaveCount(1);
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  expect((await inspect(request)).actions).toHaveLength(0);
});

async function addController(page: Page) {
  const f=ui(page);
  await f.getByRole('textbox',{name:'Device IP address',exact:true}).fill('10.192.1.10');
  await f.getByRole('button',{name:'Find',exact:true}).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
}

test('offline status allows fresh camera and LAN sends, with plain headers on both sheets',async({page,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await open(page,request,false);await addController(page);const f=ui(page);
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button',{name:'Expand all device spreadsheets',exact:true}).click();
  const cameraGroup=f.locator('[data-controller]');
  await cameraGroup.locator('[data-new-camera]').selectOption('Alpha-USB');
  const camera=cameraGroup.locator('tr[data-id]').first();
  await request.post('/__simulate',{data:{closeBroker:true}});
  await expect(cameraGroup.locator('.hc-controller-header > .hc-status')).toHaveText('Offline');
  await expect(camera.locator('[data-column="control"]')).toContainText('Offline');
  await expect(cameraGroup.locator('[data-action="send-controller"]')).toBeEnabled();
  await cameraGroup.locator('[data-action="send-controller"]').click();
  await expect(camera.locator('[data-column="sync"]')).toContainText('Verified');
  expect(Object.values((await inspect(request)).config.Camera)).toHaveLength(1);
  await expect(f.locator('.hc-letters,.hc-num,.hc-formula')).toHaveCount(0);
  await expect(camera.locator('[data-field="number"]')).toHaveValue('1');
  await f.locator('[data-tab="devices"]').click();
  const network=f.locator('[data-network-controller]');
  const lanId=await network.locator('tr[data-id]').filter({hasText:'10.20.101.200/16'}).getAttribute('data-id');
  const current=network.locator('tr[data-id="'+lanId+'"]');
  await current.locator('[data-field="operation"]').selectOption('Add');
  await current.locator('[data-field="planned"]').fill('10.20.101.201/16');
  await current.locator('[data-field="planned"]').press('Enter');
  await expect(network.locator('.hc-controller-header > .hc-status')).toHaveText('Offline');
  await expect(network.locator('[data-action="send-network-device"]')).toBeEnabled();
  await network.locator('[data-action="send-network-device"]').click();
  await f.locator('[data-action="confirm-send"]').click();
  await expect(current.locator('[data-column="sync"]')).toContainText('Verified');
  const configuration=(await inspect(request)).config;
  expect(configuration.IP.protected.IP).toBe('10.192.1.10');expect(configuration.IP.old.IP).toBe('10.20.101.200');
  expect(Object.values(configuration.IP).some((value:any)=>value.IP==='10.20.101.201')).toBe(true);
  await f.locator('[data-role="device-discovery"] > summary').click();
  await f.locator('html').evaluate(element=>element.scrollTop=0);
  await page.locator('iframe').screenshot({path:'artifacts/cyanview-devices-ui.png'});
  expect(errors).toEqual([]);
});

test('device removal persists, and Undo retains camera drafts and concurrent changes after a rejected save',async({page,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await open(page,request,false);await addController(page);const f=ui(page);
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button',{name:'Expand all device spreadsheets',exact:true}).click();
  await f.locator('[data-new-camera]').selectOption('Venice-IP');
  const draft=f.locator('[data-controller] tr[data-id]').first();
  await draft.locator('[data-field="name"]').fill('Keep this draft');await draft.locator('[data-field="name"]').press('Enter');
  await f.locator('[data-tab="devices"]').click();
  await expect.poll(async()=>(await saved(request))?.cameras?.[0]?.name).toBe('Keep this draft');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const hardware=structuredClone((await inspect(request)).config);
  let heldResolve!:()=>void,release!:()=>void;
  const held=new Promise<void>(resolve=>heldResolve=resolve),released=new Promise<void>(resolve=>release=resolve);
  let intercepted=false;
  await page.route('**/__rpc',async route=>{
    const message=route.request().postDataJSON();
    if(!intercepted&&message.commandId==='save-plan'&&message.value?.plan?.devices?.length===0){intercepted=true;heldResolve();await released;await route.fulfill({json:{error:'Simulated storage failure'}});}
    else await route.continue();
  });
  await f.locator('[data-network-controller] [data-action="remove-device"]').click();await held;
  await expect(f.locator('[data-controller],[data-network-controller]')).toHaveCount(0);
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  await f.locator('#hc-devices').getByRole('button',{name:'Undo removal',exact:true}).click();
  await expect(f.locator('[data-network-controller]')).toHaveCount(1);release();
  await expect.poll(async()=>{const plan=await saved(request);return {count:plan?.devices?.length,name:plan?.cameras?.[0]?.name,mode:plan?.uiState?.privateContent?.ui?.sendMode};}).toEqual({count:1,name:'Keep this draft',mode:'Auto send'});
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await f.locator('[data-tab="cameras"]').click();
  await expect(f.locator('[data-controller] [data-field="name"]').first()).toHaveValue('Keep this draft');
  await f.locator('[data-controller] [data-action="remove-device"]').click();
  await expect.poll(async()=>(await saved(request))?.devices?.length).toBe(0);
  await page.reload();await f.locator('[data-tab="devices"]').click();
  await expect(f.locator('[data-network-controller],[data-controller]')).toHaveCount(0);
  expect((await saved(request)).cameras).toHaveLength(0);
  expect((await inspect(request)).config).toEqual(hardware);expect((await inspect(request)).actions).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('full-page sizing keeps chrome visible while long sheets scroll across resizes and tabs',async({page,request})=>{
  await open(page,request);const f=ui(page);
  await f.getByRole('button',{name:'Expand all device spreadsheets',exact:true}).click();
  for(const size of [{width:1600,height:1100},{width:1000,height:600},{width:1900,height:1250},{width:800,height:520}]){
    await page.setViewportSize(size);
    await expect.poll(()=>f.locator('html').evaluate(element=>({width:element.clientWidth,height:element.clientHeight}))).toEqual(size);
    const bounds=await f.locator('.hc-main').evaluate(element=>{const header=element.querySelector('.hc-module-header')!.getBoundingClientRect(),footer=element.querySelector('.hc-global-foot')!.getBoundingClientRect();return {headerTop:header.top,footerBottom:footer.bottom,documentHeight:document.documentElement.scrollHeight,height:innerHeight,width:innerWidth,documentWidth:document.documentElement.scrollWidth};});
    expect(bounds.headerTop).toBeLessThanOrEqual(2);expect(Math.abs(bounds.footerBottom-size.height)).toBeLessThanOrEqual(2);expect(bounds.documentHeight).toBeLessThanOrEqual(size.height+2);expect(bounds.documentWidth).toBeLessThanOrEqual(size.width+2);
    await f.locator('#hc-cameras').evaluate(element=>element.scrollTop=element.scrollHeight);
    await expect(f.locator('.hc-module-header')).toBeInViewport();await expect(f.locator('.hc-global-foot')).toBeInViewport();await expect(f.locator('.hc-tabs')).toBeInViewport();
  }
  expect(await f.locator('#hc-cameras').evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);
  await f.locator('[data-tab="devices"]').click();await expect(f.locator('[data-role="network-devices"]')).toBeVisible();
  await f.locator('[data-tab="cameras"]').click();await expect(f.locator('[data-action="toggle-controller"][aria-expanded="true"]')).toHaveCount(5);
  await expect.poll(async()=>(await saved(request))?.uiState?.privateContent?.tab).toBe('cameras');await page.reload();
  await expect(f.locator('[data-tab="cameras"]')).toHaveAttribute('aria-selected','true');await expect(f.locator('.hc-global-foot')).toBeInViewport();
  expect((await inspect(request)).actions).toHaveLength(0);expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  await page.locator('iframe').screenshot({path:'artifacts/cyanview-full-page-ui.png'});
});

test('fast ping discovery streams verified devices, stops cleanly and retains manual results',async({page,request})=>{
  await open(page,request,false);const f=ui(page);
  await expect(f.getByRole('combobox',{name:'Discovery method',exact:true})).toHaveValue('ping');
  await request.post('/__simulate',{data:{pingDelayMs:3000}});
  await f.getByRole('combobox',{name:'Network range',exact:true}).selectOption('10.192.0.0/16');
  await f.getByRole('button',{name:'Discover',exact:true}).click();
  await expect(f.getByRole('table',{name:'Discovered devices'}).locator('tbody tr')).toHaveCount(1);
  await expect(f.locator('[data-role="scan-label"]')).toContainText('Pinging IP addresses');
  await f.getByRole('button',{name:'Stop',exact:true}).click();await expect(f.locator('[data-role="scan-label"]')).toContainText('Discovery stopped');
  await f.getByRole('textbox',{name:'Device IP address',exact:true}).fill('10.192.1.10');await f.getByRole('button',{name:'Find',exact:true}).click();
  await request.post('/__simulate',{data:{pingDelayMs:0}});
  await f.getByRole('combobox',{name:'Network range',exact:true}).selectOption('custom');await f.getByRole('textbox',{name:'Custom CIDR range',exact:true}).fill('10.20.101.250/32');
  await f.getByRole('button',{name:'Discover',exact:true}).click();await expect(f.locator('[data-role="scan-label"]')).toContainText('Discovery complete');
  await expect(f.getByRole('table',{name:'Discovered devices'}).locator('tbody tr')).toHaveCount(1);expect((await inspect(request)).actions).toHaveLength(0);
});

test('camera sheets default to numeric order and retain independent header sorting',async({page,request})=>{
  await open(page,request);const f=ui(page),group=f.locator('[data-controller="rcp1"]');
  const ids=await group.locator('tbody tr[data-id]').evaluateAll(rows=>rows.map(row=>(row as HTMLElement).dataset.id));
  const first=group.locator('tr[data-id="'+ids[0]+'"]'),second=group.locator('tr[data-id="'+ids[1]+'"]');
  await first.locator('[data-field="number"]').fill('10');await first.locator('[data-field="number"]').press('Enter');
  await second.locator('[data-field="number"]').fill('2');await second.locator('[data-field="number"]').press('Enter');
  const numbers=()=>group.locator('tbody [data-field="number"]').evaluateAll(inputs=>inputs.map(input=>Number((input as HTMLInputElement).value)));
  const ascending=await numbers();expect(ascending).toEqual([...ascending].sort((a,b)=>a-b));expect(ascending.at(-1)).toBe(10);
  await first.locator('[data-field="name"]').fill('Zulu');await first.locator('[data-field="name"]').press('Enter');
  await second.locator('[data-field="name"]').fill('Alpha');await second.locator('[data-field="name"]').press('Enter');
  await group.getByRole('button',{name:'Sort by Camera name',exact:true}).click();
  await expect(group.locator('tbody [data-field="name"]').first()).toHaveValue('Alpha');
  await expect(group.locator('[data-sort-header="name"]')).toHaveAttribute('aria-sort','ascending');
  await group.getByRole('button',{name:'Sort by Camera name',exact:true}).click();await expect(group.locator('tbody [data-field="name"]').first()).toHaveValue('Zulu');
  await group.getByRole('button',{name:'Sort by Camera number',exact:true}).click();await group.getByRole('button',{name:'Sort by Camera number',exact:true}).click();
  await expect(group.locator('tbody [data-field="number"]').first()).toHaveValue('10');
  await expect.poll(async()=>(await saved(request))?.uiState?.privateContent?.cameraSortByDevice?.rcp1).toEqual({field:'number',direction:'desc'});
  await page.reload();await expect(group.locator('[data-sort-header="number"]')).toHaveAttribute('aria-sort','descending');
  await expect(group.locator('tbody [data-field="number"]').first()).toHaveValue('10');
  await expect(f.locator('[data-controller="rcp2"] [data-sort-header="number"]')).toHaveAttribute('aria-sort','ascending');
  await chooseCameraCell(f, first.locator('[data-field="model"]'), 'Alpha-USB');
  await group.getByRole('button',{name:'Sort by Username',exact:true}).click();
  await expect(group.locator('tbody tr[data-id]').last()).toHaveAttribute('data-id',ids[0]!);
  await expect(first.locator('[data-field="login"]')).toHaveValue('');
  expect((await inspect(request)).actions).toHaveLength(0);
});

test('camera cells use the Hubble choice editor, clipboard and series fill', async ({ page, request }) => {
  await open(page, request);
  const f = ui(page), group = f.locator('[data-controller="rcp1"]');
  const rows = group.locator('tbody tr[data-id]');
  const model = rows.first().locator('[data-field="model"]');
  const sheet = await selectCameraCell(model);
  const trigger = f.getByRole('button', { name: 'Choose Camera model', exact: true });
  await expect(trigger).toBeVisible();
  await sheet.press('f');
  const choiceDialog = f.getByRole('dialog', { name: 'Select Camera model' });
  const search = choiceDialog.getByRole('combobox');
  await expect(search).toHaveValue('f');
  await search.fill('fr7');
  await expect(choiceDialog.getByRole('option', { name: 'Sony FR7', exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(model).toHaveAttribute('value', 'Sony FR7');

  await selectCameraCell(model);
  await trigger.click();
  await expect(choiceDialog.getByRole('option', { name: 'Sony FR7', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(choiceDialog.getByRole('group', { name: 'Sony', exact: true })).toBeVisible();
  await expect(group.locator('[data-camera-location]')).toHaveText('Camera 1 · Camera model');
  await expect(group.locator('[data-camera-value]')).toHaveText('Sony FR7');
  await expect(group.locator('.hc-camera-bands th')).toHaveText(['', 'Camera', 'Lens', 'Sync']);
  await search.press('Escape');

  const firstName = rows.first().locator('[data-field="name"]');
  await selectCameraCell(firstName);
  await sheet.press('x');
  await expect(firstName).toBeFocused();
  await expect(firstName).toHaveValue('x');
  await firstName.press('Escape');
  await expect(firstName).toHaveValue('Venice 2 — tight');
  await gridCell(firstName).dblclick();
  await expect(firstName).toBeFocused();
  await firstName.press('Escape');

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const modifier = await page.evaluate(() => /Mac/.test(navigator.platform)) ? 'Meta' : 'Control';
  await page.evaluate(() => navigator.clipboard.writeText('"Camera 007"\tAlpha-IP\r\nCamera 009\tAlpha-IP'));
  await page.keyboard.press(modifier + '+v');
  const names = () => rows.locator('[data-field="name"]').evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value));
  const initialNames = ['Camera 007', 'Camera 009', 'Venice 2 — handheld', 'Venice 2 — reverse'];
  await expect.poll(names).toEqual(initialNames);
  await expect(rows.nth(1).locator('[data-field="model"]')).toHaveAttribute('value', 'Alpha-IP');
  await sheet.press(modifier + '+z');
  await expect(firstName).toHaveValue('Venice 2 — tight');
  await expect(model).toHaveAttribute('value', 'Sony FR7');
  await sheet.press(modifier + '+Shift+z');
  await expect.poll(names).toEqual(initialNames);

  const selectRange = async () => {
    await selectCameraCell(firstName);
    await sheet.press('Shift+ArrowDown');
    await sheet.press('Shift+ArrowRight');
  };
  await selectRange();
  await page.keyboard.press(modifier + '+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Camera 007\tAlpha-IP\nCamera 009\tAlpha-IP');

  const handle = f.locator('.hubble-spreadsheet-fill-handle:visible');
  const preview = rows.locator('[data-hubble-spreadsheet-fill-preview]');
  const destination = rows.last().locator('td[data-column="model"]');
  const drag = async () => {
    await expect(handle).toBeVisible();
    const from = (await handle.boundingBox())!, to = (await destination.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  };
  await drag();
  await expect(preview).toHaveCount(4);
  await expect.poll(names).toEqual(initialNames);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect.poll(names).toEqual(initialNames);

  await selectRange();
  await drag();
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect.poll(names).toEqual(['Camera 007', 'Camera 009', 'Camera 011', 'Camera 013']);
  await expect(rows.last().locator('[data-field="model"]')).toHaveAttribute('value', 'Alpha-IP');
  await expect(rows.locator('[data-hubble-spreadsheet-selected]')).toHaveCount(8);
  await expect.poll(async () => (await saved(request))?.cameras?.find((row: any) => row.id === 'cam8')?.name).toBe('Camera 013');
  await sheet.press(modifier + '+z'); await expect.poll(names).toEqual(initialNames);
  await sheet.press(modifier + '+Shift+z'); await expect.poll(names).toEqual(['Camera 007', 'Camera 009', 'Camera 011', 'Camera 013']);
});

test('a multi-row camera paste sends one Auto send batch without replaying staged fields', async ({ page, request }) => {
  await open(page, request, false);
  const f = ui(page), sends: any[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/__rpc') && request.method() === 'POST') {
      const payload = request.postDataJSON();
      if (payload?.commandId === 'send') sends.push(payload.value);
    }
  });
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), rows = group.locator('tbody tr[data-id]');
  for (let i = 0; i < 2; i++) await group.locator('[data-new-camera]').selectOption('Alpha-USB');
  await group.locator('[data-action="send-controller"]').click();
  await expect(rows.locator('[data-column="sync"]')).toHaveText(['Verified', 'Verified']);

  let releaseChoices!: () => void;
  const heldChoices = new Promise<void>(resolve => { releaseChoices = resolve; });
  await page.route('**/__rpc', async route => {
    if (route.request().postDataJSON()?.commandId === 'options') await heldChoices;
    await route.continue();
  });
  const lens = rows.first().locator('[data-field="lens"]');
  const sheet = await selectCameraCell(lens);
  await sheet.press('Enter');
  const choices = f.getByRole('dialog', { name: 'Select Lens model' });
  const lensSearch = choices.getByRole('combobox');
  // The built-in list shows while the controller is still being asked.
  await expect(choices.getByRole('option', { name: 'B4 Generic', exact: true })).toBeVisible();
  await lensSearch.fill('generic');
  releaseChoices();
  await expect(choices.getByText('Loading choices…')).toHaveCount(0);
  await expect(lensSearch).toHaveValue('generic');
  await choices.getByRole('option', { name: 'B4 Generic', exact: true }).click();
  await f.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  const firstName = rows.first().locator('[data-field="name"]');
  await selectCameraCell(firstName);
  await sheet.evaluate(element => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', 'Wide\nTight');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(rows.locator('[data-column="sync"]')).toHaveText(['Pending', 'Verified']);
  await expect(firstName).toHaveValue('Wide');
  await expect(rows.nth(1).locator('[data-field="name"]')).toHaveValue('Tight');
  expect(sends).toHaveLength(2);
  expect(sends[1].items.map((row: any) => row.fields)).toEqual([['name'], ['name']]);
  expect(Object.values((await inspect(request)).config.Camera).map((row: any) => [row.Name, row.LensModel]).sort()).toEqual([['Tight', ''], ['Wide', '']]);
});

test('live lens connection choices can be selected and saved offline after reload', async ({ page, request }) => {
  await open(page, request, false);
  const f = ui(page);
  await f.locator('[data-role="manual-ip"]').fill('10.192.1.10');
  await f.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(f.locator('[data-action="add-discovered"]')).toBeEnabled();
  await f.locator('[data-action="add-discovered"]').click();
  await expect(f.locator('[data-role="device-count"]')).toHaveText('1');
  await f.locator('[data-tab="cameras"]').click();
  await f.getByRole('button', { name: 'Expand all device spreadsheets', exact: true }).click();
  const group = f.locator('[data-controller]'), row = group.locator('tbody tr[data-id]').first();
  await group.locator('[data-new-camera]').selectOption('Alpha-USB');
  await chooseCameraCell(f, row.locator('[data-field="lens"]'), 'B4 Generic');
  await group.locator('[data-action="send-controller"]').click();
  await expect(row.locator('[data-column="sync"]')).toHaveText('Verified');

  const port = row.locator('[data-field="lensPort"]'), dialog = f.getByRole('dialog', { name: 'Select Lens connection' });
  await (await selectCameraCell(port)).press('Enter');
  await expect(dialog.getByRole('option', { name: 'RIO-1-10 : 2', exact: true })).toBeVisible();
  await dialog.getByRole('combobox').press('Escape');
  await expect(f.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  const before = (await inspect(request)).actions.length;
  await page.route('**/__rpc', async route => {
    if (route.request().postDataJSON()?.commandId === 'options') await route.fulfill({ json: { error: 'Controller offline' } });
    else await route.continue();
  });
  await page.reload();
  await (await selectCameraCell(port)).press('Enter');
  await expect(dialog.getByRole('option', { name: 'RIO-1-10 : 2', exact: true })).toBeVisible();
  await dialog.getByRole('combobox').fill('rio 2');
  await dialog.getByRole('option', { name: 'RIO-1-10 : 2', exact: true }).click();
  await expect(port).toHaveAttribute('value', 'RIO-1-10 : 2');
  await expect(row.locator('[data-column="sync"]')).toHaveText('Pending');
  await expect.poll(async () => (await saved(request))?.cameras?.[0]?.lensPort).toBe('RIO-1-10 : 2');
  expect((await inspect(request)).actions).toHaveLength(before);
});
