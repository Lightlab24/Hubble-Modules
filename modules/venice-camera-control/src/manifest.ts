import { defineModuleManifest } from '@hubble/module-sdk/authoring';
import { ModuleDocumentValueSchema } from '@hubble/module-sdk';
import { defaultDocument } from './model.js';
import { defaultPresetDocument } from './presets-model.js';
export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  instanceScope: 'workspace',
  host: { minimumVersion: '2.0.18', requiredFeatures: [
    'module-workspace-instances-v1', 'module-pages-v1', 'module-page-icons-v1', 'module-custom-pages-v1', 'module-custom-pages-full-page-v1',
    'module-spreadsheet-controls-v1', 'module-spreadsheet-column-groups-v1', 'module-spreadsheet-column-editor-v1', 'module-spreadsheet-column-visibility-v1', 'module-spreadsheet-column-paint-v1', 'module-spreadsheet-text-size-v1',
    'module-spreadsheet-layout-v1', 'module-spreadsheet-extended-editing-v1', 'module-spreadsheet-workbook-tools-v1', 'module-documents-v1', 'host-service-registry-v1', 'host-alert-choices-v1',
    'module-page-windows-v1'
  ] },
  configVersion: 1,
  capabilities: ['host.documents', 'service.page.cameras'],
  settings: [], actions: [], feedback: [],
  documents: [
    { id: 'camera-plan', label: 'Camera plan', version: 1, defaultValue: ModuleDocumentValueSchema.parse(defaultDocument()) },
    { id: 'camera-presets', label: 'Camera presets', version: 1, defaultValue: ModuleDocumentValueSchema.parse(defaultPresetDocument()) }
  ],
  pages: [{ id: 'cameras', label: 'Camera Control', icon: 'ui/camera.svg', layout: 'full-page', sections: [{
    type: 'custom', id: 'frontend', label: 'VENICE camera controls', entry: 'ui/index.html', height: 560,
    // Live in every HubDash window at once: each copy follows what the others save (test/windows.test.ts). The open tab,
    // column layout and expanded sections are saved with the plan, so windows showing the page share them, as chosen.
    windows: true,
    // Cameras and Presets, each in a window of its own from HubDash's sidebar, with no tabs and nothing saved about which
    // tab or camera sheet is open. The views are the tabs' own names.
    parts: [{ view: 'cameras', title: 'Cameras' }, { view: 'presets', title: 'Presets' }],
    commands: [
      { id: 'snapshot', label: 'Read camera plan' }, { id: 'save', label: 'Save camera plan' },
      { id: 'refresh', label: 'Read camera settings' },
      { id: 'disconnect', label: 'Disconnect camera' }, { id: 'send', label: 'Send camera settings' },
      { id: 'cancel-send', label: 'Cancel queued camera settings' },
      { id: 'ping', label: 'Check which cameras answer a ping' },
      { id: 'changes', label: 'Wait for the next camera change' },
      { id: 'presets-snapshot', label: 'Read presets' }, { id: 'presets-save', label: 'Save presets' },
      { id: 'send-preset', label: 'Send a preset to a camera' },
      { id: 'cancel-preset', label: 'Stop sending a preset' }
    ]
  }] }],
});
