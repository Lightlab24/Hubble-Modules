import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// A managed fleet where only Stage RIO has a camera, and nothing has been ticked or refreshed.
async function openFleet(page: Page, request: APIRequestContext) {
  await request.post('/__reset',{data:{sample:false,remi:true}});
  const ui=page.frameLocator('iframe'),rio=ui.locator('[data-controller="CY-RIO-1-10"]'),row=rio.locator('tr[data-id]').first();
  const show=async()=>{
    await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
    await ui.locator('[data-tab="cameras"]').click();
    if(!await row.isVisible())await rio.locator('[data-action="toggle-controller"]').click();
    await expect(row).toBeVisible();
  };
  await page.goto('/');await show();
  return {ui,rio,row,show,rcp:ui.locator('[data-controller="CY-RCP-1-20"]'),control:row.locator('[data-column="control"]'),status:row.locator('[data-column="cameraStatus"]'),
    tick:row.locator('[data-field="controlEnabled"] [role="checkbox"]'),live:ui.locator('[data-role="live-summary"]'),note:rio.locator('[data-connection-note]')};
}
const mark=(group:Locator)=>group.locator('.hc-controller-header > .hc-status');
const inspect=async(request:APIRequestContext)=>(await request.get('/__inspect')).json();
const stored=async(request:APIRequestContext,id:string)=>(await inspect(request)).records.find(([key]:[string])=>key===id)?.[1].value;

test('Camera Control Enabled is immediate through held saves and retains configuration edits after failure', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await request.post('/__reset', { data: { sample: true } });
  await page.goto('/');
  const ui=page.frameLocator('iframe');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  const rows=ui.locator('[data-controller="rcp1"] tr[data-id]');
  const flags=rows.locator('[data-field="controlEnabled"] [role="checkbox"]');
  await expect(flags).toHaveCount(4);
  await request.post('/__simulate',{data:{holdControlWrites:true}});
  await flags.nth(0).check(); await expect(flags.nth(0)).toBeChecked();
  await flags.nth(1).check(); await expect(flags.nth(1)).toBeChecked();
  const name=rows.first().locator('input[data-field="name"]');
  await name.fill('Unrelated camera edit'); await name.press('Enter');
  await expect(flags.nth(0)).toBeChecked(); await expect(flags.nth(1)).toBeChecked();
  const held=await (await request.get('/__inspect')).json();
  expect(held.records.some(([id]:[string])=>id==='sample-camera-control')).toBe(false);
  await request.post('/__simulate',{data:{failControlWrite:true,releaseControlWrites:true}});
  await expect(flags.nth(0)).not.toBeChecked(); await expect(flags.nth(1)).not.toBeChecked();
  await expect(name).toHaveValue('Unrelated camera edit');
  await flags.nth(0).check();
  await expect.poll(async()=>{
    const inspected=await(await request.get('/__inspect')).json();
    return inspected.records.find(([id]:[string])=>id==='sample-camera-control')?.[1].value.enabled.cam1;
  }).toBe(true);
  await page.reload(); await ui.locator('[data-tab="cameras"]').click();
  await expect(flags.nth(0)).toBeChecked();
  expect((await(await request.get('/__inspect')).json()).actions).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('control checkmarks use shared clipboard and fill without staging camera writes', async ({page,request})=>{
  await request.post('/__reset',{data:{sample:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  const group=ui.locator('[data-controller="rcp1"]'),rows=group.locator('tr[data-id]'),table=group.getByRole('grid');
  const cells=rows.locator('[data-column="controlEnabled"]'),flags=cells.locator('[role="checkbox"]');
  await expect(table).toHaveAttribute('tabindex','0');await cells.first().click({position:{x:10,y:15}});
  await table.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','TRUE\nFALSE\nTRUE');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await expect(flags.nth(0)).toBeChecked();await expect(flags.nth(1)).not.toBeChecked();await expect(flags.nth(2)).toBeChecked();
  await cells.first().click({position:{x:10,y:15}});
  const handle=ui.locator('.hubble-spreadsheet-fill-handle:visible');await expect(handle).toBeVisible();
  const from=await handle.boundingBox(),to=await cells.last().boundingBox();
  if(!from||!to)throw new Error('Fill geometry unavailable');
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:8});await page.mouse.up();
  for(let i=0;i<4;i++)await expect(flags.nth(i)).toBeChecked();
  const inspected=await(await request.get('/__inspect')).json();expect(inspected.actions).toHaveLength(0);
  const plan=inspected.records.find(([id]:[string])=>id==='sample-plan');
  expect(plan[1].value.devices).toHaveLength(5);
  await page.screenshot({path:'artifacts/cyanview-0.1.19-control-checkboxes.png'});
});

test('Enable all and Single switch show at once through held saves, take further edits and roll back on failure', async ({page,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await request.post('/__reset',{data:{sample:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  const group=ui.locator('[data-controller="rcp1"]'),rows=group.locator('tr[data-id]'),flags=rows.locator('[data-field="controlEnabled"] [role="checkbox"]');
  const single=group.locator('input[data-control-single]'),all=group.locator('button[data-action="control-enable-all"]'),count=group.locator('[data-control-count]');
  const ticks=async()=>flags.evaluateAll(inputs=>inputs.map(input=>input.getAttribute('aria-checked')==='true'));
  await expect(flags).toHaveCount(4);await expect(count).toHaveText('0 enabled');await expect(all).toHaveText('Enable all');await expect(single).not.toBeChecked();
  await request.post('/__simulate',{data:{holdControlWrites:true}});
  await all.click();
  expect(await ticks()).toEqual([true,true,true,true]);await expect(all).toHaveText('Disable all');await expect(count).toHaveText('4 enabled');
  // Second edit before the first save returns: narrows to the first camera.
  await single.check();
  expect(await ticks()).toEqual([true,false,false,false]);await expect(single).toBeChecked();await expect(all).toHaveText('Enable all');await expect(count).toHaveText('1 enabled');
  // Third edit: with Single switch on, a tick moves rather than adds.
  await flags.nth(2).check();
  expect(await ticks()).toEqual([false,false,true,false]);await expect(count).toHaveText('1 enabled');
  const name=rows.first().locator('input[data-field="name"]');await name.fill('Unrelated camera edit');await name.press('Enter');
  // Worker state arriving meanwhile must not reset any of it.
  await page.waitForTimeout(500);
  expect(await ticks()).toEqual([false,false,true,false]);await expect(single).toBeChecked();
  expect((await(await request.get('/__inspect')).json()).records.some(([id]:[string])=>id==='sample-camera-control')).toBe(false);
  await request.post('/__simulate',{data:{failControlWrite:true,releaseControlWrites:true}});
  await expect(ui.locator('[data-role="toast"]')).toContainText(/Simulated storage failure|Selection cancelled/);
  await expect.poll(ticks).toEqual([false,false,false,false]);
  await expect(single).not.toBeChecked();await expect(all).toHaveText('Enable all');await expect(count).toHaveText('0 enabled');
  await expect(name).toHaveValue('Unrelated camera edit');
  // Controls still work after the failure, and survive a reload.
  await all.click();expect(await ticks()).toEqual([true,true,true,true]);
  await single.check();expect(await ticks()).toEqual([true,false,false,false]);
  await expect.poll(async()=>{const value=(await(await request.get('/__inspect')).json()).records.find(([id]:[string])=>id==='sample-camera-control')?.[1].value;return value?.singleSwitch?.rcp1;}).toBe(true);
  await page.reload();await ui.locator('[data-tab="cameras"]').click();
  await expect.poll(ticks).toEqual([true,false,false,false]);await expect(single).toBeChecked();await expect(count).toHaveText('1 enabled');
  // Enable all turns Single switch off, and turning it off leaves the tick alone. Sample data sends nothing.
  await all.click();expect(await ticks()).toEqual([true,true,true,true]);await expect(single).not.toBeChecked();
  await all.click();expect(await ticks()).toEqual([false,false,false,false]);await expect(all).toHaveText('Enable all');
  expect((await(await request.get('/__inspect')).json()).actions).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('Recording and Status follow the camera live and stay read-only', async ({page,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await request.post('/__reset',{data:{sample:false,remi:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await ui.locator('[data-tab="cameras"]').click();
  const group=ui.locator('[data-controller="CY-RIO-1-10"]');
  if(!await group.locator('tr[data-id]').first().isVisible())await group.locator('[data-action="toggle-controller"]').click();
  const row=group.locator('tr[data-id]').first();
  const recording=row.locator('[data-column="recording"]'),status=row.locator('[data-column="cameraStatus"]'),count=group.locator('[data-control-count]');
  const mqtt=(topic:string,value:string)=>request.post('/__simulate',{data:{mqtt:{topic,value}}});
  // Every managed RCP and RIO is watched from the start, ticked or not.
  await expect(recording).toHaveText('Stopped');await expect(status).toHaveText('Ready');await expect(count).toHaveText('0 enabled');
  await row.locator('[data-field="controlEnabled"] [role="checkbox"]').check();
  await expect(count).toHaveText('1 enabled');
  await expect(recording).toHaveText('Stopped');await expect(status).toHaveText('Ready');
  await mqtt('unit/a/camhead/status/volatile/recording','1');
  await expect(recording).toHaveText('Recording');await expect(recording.locator('.hc-recording')).toBeVisible();
  await mqtt('unit/a/camhead/status/volatile/rec_lock','1');
  await expect(status).toHaveText('Recording locked');
  await mqtt('unit/a/camhead/status/volatile/control','offline');
  await expect(recording).toHaveText('Unknown');await expect(status).toHaveText('Camera offline');
  await expect(count).toHaveText('1 enabled · 1 unavailable');
  await page.screenshot({path:'artifacts/cyanview-0.1.30-recording-status.png'});
  // A camera that comes back has to report again before it can be trusted.
  await mqtt('unit/a/camhead/status/volatile/control','online');
  await expect(status).toHaveText('Waiting for camera status');await expect(count).toHaveText('1 enabled');
  await mqtt('unit/a/camhead/status/volatile/recording','1');
  await expect(recording).toHaveText('Recording');await expect(status).toHaveText('Recording locked');
  // Read-only: selecting shows the value, and a paste changes nothing.
  await recording.click();
  await expect(group.locator('[data-camera-location]')).toHaveText(/Recording$/);
  const table=group.getByRole('grid');
  await table.evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','Stopped');element.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await expect(recording).toHaveText('Recording');
  // Sorting by either column keeps the row painting.
  await group.locator('[data-sort-field="recording"]').click();
  await expect(group.locator('[data-sort-field="recording"]')).toBeVisible();
  await expect(group.locator('tr[data-id]').first().locator('[data-column="recording"]')).toHaveText('Recording');
  const inspected=await(await request.get('/__inspect')).json();
  expect(inspected.actions).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('Recording and Status can be hidden, and stay hidden after a reload', async ({page,request})=>{
  await request.post('/__reset',{data:{sample:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  const group=ui.locator('[data-controller="rcp1"]');
  await expect(group.locator('td[data-column="recording"]')).toHaveCount(4);await expect(group.locator('td[data-column="cameraStatus"]')).toHaveCount(4);
  await group.getByRole('button',{name:'Choose visible columns',exact:true}).click();
  await ui.getByRole('searchbox',{name:'Search columns'}).fill('Recording');
  await ui.getByRole('menuitemcheckbox',{name:'Recording status',exact:true}).click();
  await page.keyboard.press('Escape');
  await expect(group.locator('td[data-column="cameraStatus"]')).toHaveCount(0);await expect(group.locator('td[data-column="recording"]')).toHaveCount(4);
  const hidden=async()=>(await(await request.post('/__rpc',{data:{commandId:'read-plan'}})).json()).result.plan?.uiState?.privateContent?.hiddenCameraColumnsByDevice?.rcp1;
  await expect.poll(hidden).toContain('cameraStatus');
  await page.reload();await ui.locator('[data-tab="cameras"]').click();
  await expect(group.locator('td[data-column="recording"]')).toHaveCount(4);await expect(group.locator('td[data-column="cameraStatus"]')).toHaveCount(0);
});

test('an open page follows a restarted worker instead of ignoring its lower sequence', async ({page,request})=>{
  await request.post('/__reset',{data:{sample:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  const group=ui.locator('[data-controller="rcp1"]'),all=group.locator('button[data-action="control-enable-all"]'),count=group.locator('[data-control-count]');
  // Several real changes, so the page has counted well past where a new worker starts.
  await all.click();await expect(count).toHaveText('4 enabled');
  await all.click();await expect(count).toHaveText('0 enabled');
  await all.click();await expect(count).toHaveText('4 enabled');
  await expect.poll(async()=>(await(await request.get('/__inspect')).json()).records.find(([id]:[string])=>id==='sample-camera-control')?.[1].value.enabled.cam1).toBe(true);
  await request.post('/__reset',{data:{sample:true}});
  await expect(count).toHaveText('0 enabled');
  await expect(all).toHaveText('Enable all');
});

test('after a worker restart every RCP and RIO answers by itself, and nothing reads Offline before it has been tried', async ({page,request})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const {ui,rio,rcp,show,control,status,tick,live,note}=await openFleet(page,request);
  // Nothing is ticked and nothing has been refreshed.
  await expect(tick).not.toBeChecked();
  await expect(mark(rio)).toHaveText('Online');await expect(mark(rcp)).toHaveText('Online');
  await expect(control).toHaveText('Online');await expect(status).toHaveText('Ready');
  await expect(note).toHaveText('Connected at 10.192.1.10');
  await expect(live).toContainText('3 online / 0 offline');await expect(live).not.toContainText('not checked');
  expect((await inspect(request)).opened).toEqual([0,0,0]);
  await page.screenshot({path:'artifacts/cyanview-0.1.30-control-status.png'});
  // Have the page save what it shows, so old status is there to come back.
  await ui.getByRole('button',{name:'Refresh all',exact:true}).click();
  await expect(ui.locator('[data-role="toast"]')).toHaveText('Settings refreshed · edits retained');
  await expect.poll(async()=>(await stored(request,'plan'))?.devices?.map((device:{online:unknown})=>device.online)).toEqual([true,true,true]);
  // A real host reloads the page when it restarts a worker. These brokers accept the connection and don't answer yet.
  await request.post('/__simulate',{data:{mqttControls:{silent:true}}});
  const before=await inspect(request);
  await request.post('/__restart');await page.reload();await show();
  await expect(status).toHaveText('Connecting to the controller');
  await expect(mark(rio)).toHaveText('Not checked');await expect(mark(rcp)).toHaveText('Not checked');
  await expect(control).toHaveText('Not checked');await expect(note).toHaveText('Not checked yet');
  await expect(live).toContainText('0 online / 0 offline / 3 not checked');
  await expect(ui.locator('[data-role="camera-foot"]')).toHaveText('0 pending · 0 cameras offline · 1 not checked');
  await expect(ui.getByText('Offline',{exact:true})).toHaveCount(0);
  expect(await control.evaluate(cell=>cell.scrollWidth<=cell.clientWidth),'The label fits at the default width').toBe(true);
  await page.screenshot({path:'artifacts/cyanview-0.1.30-not-checked.png'});
  expect((await inspect(request)).opened).toEqual(before.opened);
  await request.post('/__simulate',{data:{mqttControls:{silent:false}}});
  await expect(control).toHaveText('Online',{timeout:10000});await expect(status).toHaveText('Ready');await expect(mark(rcp)).toHaveText('Online');
  expect(errors).toEqual([]);
});

test('Refresh all picks up outside changes in a one-off read, and leaves RCP and RIO status to MQTT', async ({page,request})=>{
  const {ui,rio,row,control,status}=await openFleet(page,request);
  const toast=ui.locator('[data-role="toast"]'),refresh=ui.getByRole('button',{name:'Refresh all',exact:true});
  const simulate=(data:object)=>request.post('/__simulate',{data});
  await expect(control).toHaveText('Online');
  await simulate({cameraName:'Changed outside'});
  await refresh.click();await expect(refresh).toBeEnabled();
  await expect(toast).toHaveText('Settings refreshed · edits retained');
  await expect(row.locator('[data-field="name"]')).toHaveValue('Changed outside');
  await expect.poll(async()=>(await inspect(request)).openSockets,'Nothing stays open').toEqual([0,0,0]);
  // With the broker gone, a successful read can't make the controller look ready for commands.
  await simulate({closeBroker:true});
  await expect(mark(rio)).toHaveText('Offline');await expect(control).toHaveText('Offline');
  await refresh.click();await expect(refresh).toBeEnabled();
  await expect(mark(rio)).toHaveText('Offline');await expect(control).toHaveText('Offline');await expect(status).toHaveText('CyanView RCP is unavailable');
});

test('Refresh all names a controller it could not read, without changing its MQTT status', async ({page,request})=>{
  const {ui,rio,control}=await openFleet(page,request);
  await expect(control).toHaveText('Online');
  await request.post('/__simulate',{data:{closeController:true}});
  await ui.getByRole('button',{name:'Refresh all',exact:true}).click();
  await expect(ui.locator('[data-role="toast"]')).toHaveText('Could not read Stage RIO · edits retained');
  await expect(mark(rio)).toHaveText('Online');await expect(control).toHaveText('Online');
});

test('Offline only follows a connection that failed or a camera that reported it', async ({page,request})=>{
  const {rio,rcp,control,status,live,note}=await openFleet(page,request);
  const simulate=(data:object)=>request.post('/__simulate',{data});
  await expect(control).toHaveText('Online');
  // An open page drops what the old worker reported. The new worker's attempt is still out, so there's no answer yet.
  await simulate({mqttControls:{silent:true}});
  await request.post('/__restart');
  await expect(status).toHaveText('Connecting to the controller');
  await expect(control).toHaveText('Not checked');await expect(mark(rio)).toHaveText('Not checked');await expect(mark(rcp)).toHaveText('Not checked');
  await expect(mark(rio)).toHaveText('Offline',{timeout:6000});await expect(control).toHaveText('Offline');
  await expect(status).toHaveText('CyanView RCP connection timed out');await expect(note).toHaveText('Last reported offline');
  await expect(live).toContainText('0 online / 3 offline');
  // It reconnects by itself.
  await simulate({mqttControls:{silent:false}});
  await expect(control).toHaveText('Online',{timeout:8000});await expect(status).toHaveText('Ready');await expect(mark(rio)).toHaveText('Online');
  // A camera that reports offline doesn't take its controller with it.
  await simulate({mqtt:{topic:'unit/a/camhead/status/volatile/control',value:'offline'}});
  await expect(control).toHaveText('Offline');await expect(status).toHaveText('Camera offline');await expect(mark(rio)).toHaveText('Online');
  await simulate({mqtt:{topic:'unit/a/camhead/status/volatile/control',value:'online'}});
  await expect(control).toHaveText('Online');
  await simulate({closeBroker:true});
  await expect(mark(rio)).toHaveText('Offline');await expect(control).toHaveText('Offline');
  expect((await inspect(request)).actions).toHaveLength(0);
});

test('a Gateway is watched over MQTT like an RCP, and its cameras can be ticked', async ({page,request})=>{
  await request.post('/__reset',{data:{sample:false,gateway:true}});await page.goto('/');
  const ui=page.frameLocator('iframe'),refresh=ui.getByRole('button',{name:'Refresh all',exact:true});
  const group=ui.locator('[data-controller="CY-GWY-1-10"]'),row=group.locator('tr[data-id]').first(),control=row.locator('[data-column="control"]'),note=group.locator('[data-connection-note]');
  const tick=row.locator('[data-field="controlEnabled"] [role="checkbox"]');
  const show=async()=>{
    await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
    await ui.locator('[data-tab="cameras"]').click();
    if(!await row.isVisible())await group.locator('[data-action="toggle-controller"]').click();
  };
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Workspace saved');
  await ui.getByRole('textbox',{name:'Device IP address',exact:true}).fill('10.192.1.10');
  await ui.getByRole('button',{name:'Find',exact:true}).click();
  await expect(ui.locator('[data-action="add-discovered"]')).toBeEnabled();
  await ui.locator('[data-action="add-discovered"]').click();
  await expect(ui.locator('[data-role="device-count"]')).toHaveText('1');
  await show();
  // Its broker answers, as an RCP's does.
  await expect(mark(group)).toHaveText('Online');await expect(control).toHaveText('Online');await expect(note).toHaveText('Connected at 10.192.1.10');
  await expect.poll(async()=>(await inspect(request)).mqttConnections).toBeGreaterThan(0);
  await expect.poll(async()=>(await inspect(request)).openSockets,'Nothing stays open').toEqual([0]);
  await expect(tick).toBeEnabled();await tick.check();await expect(tick).toBeChecked();
  await expect.poll(async()=>Object.values((await stored(request,'camera-control'))?.enabled??{})).toEqual([true]);
  // A new worker answers by itself, with no Refresh all, and the tick stays.
  await request.post('/__restart');await page.reload();await show();
  await expect(mark(group)).toHaveText('Online');await expect(control).toHaveText('Online');await expect(tick).toBeChecked();
  // With the broker gone it reads Offline, and a read that succeeds can't make it look ready.
  await request.post('/__simulate',{data:{closeBroker:true}});
  await expect(mark(group)).toHaveText('Offline');await expect(control).toHaveText('Offline');
  await refresh.click();await expect(refresh).toBeEnabled();
  await expect(mark(group)).toHaveText('Offline');await expect(note).toHaveText('Last reported offline');
  expect((await inspect(request)).actions).toHaveLength(0);
});

test('sample data keeps its own status', async ({page,request})=>{
  await request.post('/__reset',{data:{sample:true}});await page.goto('/');
  const ui=page.frameLocator('iframe');
  await expect(ui.locator('[data-role="saved-label"]')).toContainText('Sample data');
  await ui.locator('[data-tab="cameras"]').click();
  await expect(mark(ui.locator('[data-controller="rcp1"]'))).toHaveText('Online');
  await expect(mark(ui.locator('[data-controller="rio3"]'))).toHaveText('Offline');
  await expect(ui.locator('[data-role="live-summary"]')).toContainText('4 online / 1 offline');
  await expect(ui.locator('[data-role="live-summary"]')).not.toContainText('not checked');
});

test('a one-off read during a REMI send says nothing about live status', async ({page,request})=>{
  const {ui,rcp}=await openFleet(page,request);
  await rcp.locator('[data-action="toggle-controller"]').click();
  await rcp.locator('[data-new-camera]').selectOption({label:'REMI cameras…'});
  const panel=rcp.locator('[data-remi-panel]');
  await expect(panel.getByLabel('REMI source',{exact:true})).toHaveValue('CY-RIO-1-10');
  await panel.getByRole('button',{name:'Add',exact:true}).click();
  await expect(panel.getByText('Pending add',{exact:true})).toBeVisible();
  await request.post('/__simulate',{data:{closeBroker:true}});
  await expect(mark(rcp)).toHaveText('Offline');
  // With state held back, nothing can correct a wrong mark.
  await request.post('/__simulate',{data:{pauseState:true}});
  await rcp.locator('[data-action="send-controller"]').click();
  await ui.locator('[data-remi-apply]').click();
  await expect(rcp.locator('[data-remi-model]')).toHaveText('Venice-IP');
  await expect(mark(rcp)).toHaveText('Offline');
});
