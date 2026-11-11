import { expect, test, type FrameLocator } from '@playwright/test';

// Pending sends doesn't open by itself; this opens it if it's shut.
async function openPending(frame: FrameLocator) {
  const list = frame.locator('[data-role="pending-sends"]');
  if (await list.isHidden()) await frame.locator('.hc-panel:not([hidden]) .hc-toolbar [data-action="toggle-pending-sends"]').click();
  await expect(list).toBeVisible();
  return list;
}
test('adding and renaming a RIO camera updates a chain in Camera Configuration', async ({ page, request }) => {
  await request.post('/__reset', { data: { sample:false, remi:true } });
  await page.goto('/');
  const ui = page.frameLocator('iframe');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await ui.locator('[data-tab="assignment"]').click().then(() => ui.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  const sheet = (id:string) => ui.locator('[data-controller="'+id+'"]');
  const expectImported = async (id:string, source:string) => {
    await expect(sheet(id).locator('[data-remi-model]')).toHaveText('Venice-IP');
    await expect(sheet(id).locator('[data-remi-model-source]')).toHaveText(source);
    await expect(sheet(id).locator('[data-column="model"]')).not.toContainText(/cyan\s*-\s*imported/i);
  };
  const open = async (id:string) => {
    const group = sheet(id);
    if (!await group.locator('[data-camera-count]').isVisible()) await group.locator('[data-action="toggle-controller"]').click();
    await group.locator('[data-action="open-remi-panel"]').click();
    return group.locator('[data-remi-panel]');
  };
  const master = await open('CY-RCP-1-20');
  await expect(master.locator('[data-remi-source]')).toHaveValue('CY-RIO-1-10');
  await expect(master.getByRole('button',{name:'Source IP'})).toBeHidden();
  await master.getByRole('button',{name:'Add',exact:true}).click();
  await expect(master.getByText('Pending add',{exact:true})).toBeVisible();
  await sheet('CY-RCP-1-20').locator('[data-action="send-controller"]').click();
  await expect(ui.getByRole('dialog')).toContainText('Import 1 · Wide · Stage RIO');
  await ui.locator('[data-remi-apply]').click();
  await expectImported('CY-RCP-1-20','Stage RIO');
  const controlFlag=sheet('CY-RCP-1-20').locator('[data-field="controlEnabled"] [role="checkbox"]');
  await expect(controlFlag).toBeEnabled();
  const beforeControl=(await(await request.get('/__inspect')).json()).fleet[1].actions.length;
  await controlFlag.check();await expect(controlFlag).toBeChecked();
  await expect.poll(async()=>{
    const state=await(await request.get('/__state')).json();
    return Object.values(state.values.cameraControl.enabled).filter(Boolean).length;
  }).toBe(1);
  expect((await(await request.get('/__inspect')).json()).fleet[1].actions).toHaveLength(beforeControl);

  await ui.locator('[data-tab="devices"]').click();
  await ui.locator('[data-device-view="details"]').click();
  const stage = ui.locator('[data-network-controller="CY-RIO-1-10"]');
  const deviceName = stage.locator('[data-device-setting="name"]');
  if (!await deviceName.isVisible()) await stage.locator('[data-action="toggle-network-device"]').click();
  await deviceName.fill('Stage Left');
  await deviceName.press('Enter');
  await ui.locator('[data-tab="assignment"]').click().then(() => ui.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]').click());
  await expect(master.getByRole('button',{name:'REMI source',exact:true})).toHaveText('Stage Left · RIO');
  await expectImported('CY-RCP-1-20','Stage Left');

  await ui.locator('[data-action="send-mode"][data-mode="Auto send"]').click();
  const leaf = await open('CY-RCP-1-30');
  await leaf.getByRole('button',{name:'REMI source',exact:true}).click();
  await ui.getByRole('listbox',{name:'REMI source'}).getByRole('option',{name:'Master RCP · RCP',exact:true}).click();
  await leaf.getByRole('button',{name:'Add',exact:true}).click();
  await expectImported('CY-RCP-1-30','Stage Left');

  const sourceName = sheet('CY-RIO-1-10').locator('input[data-field="name"]');
  await sourceName.fill('Stage wide');
  await sourceName.press('Enter');
  for (const id of ['CY-RCP-1-20','CY-RCP-1-30']) {
    const name = sheet(id).locator('input[data-field="name"]');
    await expect(name).toHaveValue('Stage wide');
    await expect(name).toBeDisabled();
    await expectImported(id,'Stage Left');
  }
  const { fleet } = await (await request.get('/__inspect')).json();
  for (const device of fleet.slice(1)) {
    expect(device.actions.filter((action:any)=>action.new?.[0]==='CyElement.SessionImporter')).toHaveLength(1);
    expect(device.actions.filter((action:any)=>action.update?.changes?.auto_camera==='0')).toHaveLength(1);
    expect(Object.values(device.config.Camera)).toHaveLength(1);
  }
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await page.reload();
  await expect(ui.locator('.hc-panel:not([hidden]) [data-remi-view="controllers"]')).toHaveAttribute('aria-pressed','true');
  await expect(sheet('CY-RIO-1-10').locator('.hc-controller-header')).toContainText('Stage Left');
  await expectImported('CY-RCP-1-20','Stage Left');
  await expectImported('CY-RCP-1-30','Stage Left');

  const downstream = sheet('CY-RCP-1-30');
  await downstream.locator('[data-column="model"]').last().click({ button: 'right' });
  await ui.getByRole('menuitem', { name: 'Remove REMI copy', exact: true }).click();
  await openPending(ui);
  await expect(ui.locator('[data-pending-line="remi:CY-RCP-1-30"]')).toContainText('On → Off');
  await expect(ui.locator('[data-pending-line="master"]')).toHaveCount(0);
  await (await openPending(ui)).locator('[data-action="send-all-pending"]').click();
  await expect(downstream.locator('tr[data-id]')).toHaveCount(0);
  await expectImported('CY-RCP-1-20','Stage Left');
  await expect(sheet('CY-RIO-1-10').locator('input[data-field="name"]')).toHaveValue('Stage wide');
});
