import { defineModuleManifest } from '@hubble/module-sdk/authoring';
import { ModuleDocumentValueSchema } from '@hubble/module-sdk';
import { actions, matrix, MATCHES } from './actions.js';
import { defaultDocument } from './model.js';

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: { minimumVersion: '2.2.0', requiredFeatures: [
    'module-pages-v1', 'module-custom-pages-v1', 'module-custom-pages-full-page-v1', 'module-matrix-v1', 'module-feedback-observers-v1', 'module-choices-v2',
    'module-spreadsheet-controls-v1', 'module-spreadsheet-column-groups-v1', 'module-spreadsheet-column-editor-v1', 'module-spreadsheet-column-visibility-v1', 'module-spreadsheet-column-paint-v1', 'module-spreadsheet-text-size-v1',
    'module-spreadsheet-layout-v1', 'module-spreadsheet-extended-editing-v1', 'module-spreadsheet-workbook-tools-v1', 'module-documents-v1', 'host-service-registry-v1', 'module-disabled-state-v1',
  ] },
  configVersion: 2,
  lifecycle: { runWhenDisabled: true },
  capabilities: ['service.page.fshdr', 'host.documents'],
  // `setup` is the earlier version's unit list. It is only read, once, to bring those units into the plan.
  documents: [
    { id: 'fshdr-plan', label: 'FS-HDR plan', version: 1, defaultValue: ModuleDocumentValueSchema.parse(defaultDocument()) },
    { id: 'setup', label: 'FS-HDR setup (earlier version)', version: 1, defaultValue: {} },
  ],
  settings: [],
  actions: [...actions],
  feedback: [
    { id: 'all-online', label: 'All FS-HDRs online', description: 'Every configured unit is delivering live state', fields: [] },
    { id: MATCHES, label: 'HDR transform matches', description: 'Every selected processor reports the transform in its Matrix row', fields: [] },
  ],
  matrix,
  pages: [{ id: 'fshdr', label: 'FS-HDR', layout: 'full-page', sections: [{
    type: 'custom', id: 'frontend', label: 'FS-HDR', entry: 'ui/index.html', height: 560,
    commands: [
      { id: 'snapshot', label: 'Read the FS-HDR plan' }, { id: 'save', label: 'Save the FS-HDR plan' },
      { id: 'refresh', label: 'Read every unit again' }, { id: 'send', label: 'Send settings to a unit' },
      { id: 'cancel-send', label: 'Cancel queued settings' }, { id: 'changes', label: 'Wait for the next change at a unit' },
    ],
  }] }],
});
