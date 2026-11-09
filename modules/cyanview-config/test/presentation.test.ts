import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PresentationLedger } from '../src/presentation-ledger.js';
import { fixture } from './helpers.js';

test('a failed painted layout repairs queued saves without replacing unrelated camera drafts', () => {
  const ledger = new PresentationLedger<{ fields: string[]; textSize: number }>();
  const initial = { fields: [], textSize: 13 }, painted = { fields: ['irisMotor', 'irisMin', 'irisMax'], textSize: 13 };
  ledger.change('camera:one', initial, painted);
  const first = ledger.ticket();
  ledger.change('camera:one', painted, { ...painted, textSize: 19 });
  const later = ledger.ticket();
  ledger.change('camera:two', initial, { fields: ['focusMotor'], textSize: 13 });
  const rollback = ledger.failed(first);
  assert.deepEqual(rollback.map(item => ({ key: item.key, value: item.value })), [{ key: 'camera:one', value: initial }]);
  const plan = { name: 'Independent later edit', layout: painted };
  for (const repair of ledger.repairs(later)) plan.layout = repair.value;
  assert.deepEqual(plan, { name: 'Independent later edit', layout: initial });
  ledger.saved(later);
  assert.equal(ledger.failed(ledger.ticket())[0]?.key, 'camera:two');
  ledger.change('camera:one', initial, { ...initial, textSize: 14 });
  const retry = ledger.ticket();
  assert.deepEqual(ledger.repairs(retry), []);
  ledger.saved(retry);
  assert.deepEqual(ledger.failed(retry), []);
});

test('an earlier acknowledged layout remains the rollback base for a rejected second edit', () => {
  const ledger = new PresentationLedger<number>();
  ledger.change('sheet', 13, 14); const first = ledger.ticket();
  ledger.change('sheet', 14, 15); const second = ledger.ticket();
  ledger.saved(first);
  assert.equal(ledger.failed(second)[0]?.value, 14);
  assert.equal(ledger.repairs(second)[0]?.value, 14);
});

test('portable presentation state preserves legacy layouts, credentials and staged camera settings across repository reload', async () => {
  const f = fixture({ sampleData: false });
  try {
    const plan = { formatVersion: 1 as const, devices: [{ id: 'rcp', serial: 'CY-RCP-test', address: '192.0.2.10' }],
      cameras: [{ id: 'camera', device: 'rcp', number: '7', name: 'Staged name', password: 'local-test-password', dirty: ['name'], pending: true, lens: 'ARRI - cforce', enabledLensAxes: ['iris'], irisTorque: '4' }], lans: [],
      uiState: { privateContent: { revision: 6, cameraLayouts: { rcp: { columns: { name: 217 }, rows: { camera: 62 }, groups: { iris: { order: ['irisTorque', 'irisSummary'], collapsed: ['irisTorque'] } }, textSize: 19, hiddenGroups: ['lens'] } }, hiddenCameraColumnsByDevice: { rcp: ['password'] }, axisGroupsByDevice: { rcp: { iris: false, zoom: true, focus: false } }, deviceOrder: ['rcp'], hiddenNetworkColumnsByDevice: { rcp: ['dns1'] }, cameraSheetsByDevice: { rcp: { activeSheetId: 'network', sheets: [{ id: 'settings', name: 'Settings', view: 'rows', layout: { version: 2, columns: { name: 180 }, rows: {}, groups: {}, hiddenGroups: [], textSize: 15, cameraWidths: { camera: 240 }, settingHeights: { port: 50 }, settingWidth: 260 }, hidden: ['login'], expanded: { iris: true, zoom: false, focus: false } }, { id: 'network', name: 'Network', view: 'columns' }] } } } } };
    await f.repository.write(null, plan, f.signal);
    const exported = JSON.stringify([...f.records]);
    const transferred = fixture({ sampleData: false }, {}, new Map(JSON.parse(exported)));
    try {
      const restored = (await transferred.repository.read(transferred.signal)).plan;
      assert.deepEqual(restored, plan);
      assert.deepEqual(restored.uiState?.privateContent.cameraLayouts.rcp.groups.iris.collapsed, ['irisTorque']);
      assert.deepEqual(restored.uiState?.privateContent.cameraSheetsByDevice.rcp.sheets.map((sheet: { name: string; view: string }) => [sheet.name, sheet.view]), [['Settings', 'rows'], ['Network', 'columns']]);
      assert.equal(restored.cameras[0]?.pending, true);
    } finally { await transferred.instance.dispose(); }
  } finally { await f.instance.dispose(); }
});
