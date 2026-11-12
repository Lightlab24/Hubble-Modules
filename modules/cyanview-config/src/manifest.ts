import { defineModuleManifest } from '@hubble/module-sdk/authoring';
import { documentDefinitions } from './repository.js';
import { ModuleFrontendSectionSchema } from '@hubble/module-sdk/frontend';
import { matrix, controlActions } from './control/matrix.js';
import {
  MODULE_SPREADSHEET_CONTROLS_FEATURE,
  MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE,
  MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE,
  MODULE_SPREADSHEET_LAYOUT_FEATURE,
} from '@hubble/module-sdk/spreadsheet-controls';
export default defineModuleManifest({
  formatVersion: 1, apiVersion: 1, configVersion: 1,
  instanceScope: 'workspace',
  host: { minimumVersion: '2.0.18', requiredFeatures: [
    'module-workspace-instances-v1', 'module-pages-v1', 'module-page-icons-v1', 'module-custom-pages-v1', 'module-documents-v1',
    'host-service-registry-v1', 'module-custom-pages-full-page-v1', 'module-helpers-v1',
    MODULE_SPREADSHEET_CONTROLS_FEATURE, MODULE_SPREADSHEET_COLUMN_GROUPS_FEATURE, MODULE_SPREADSHEET_EXTENDED_EDITING_FEATURE,
    MODULE_SPREADSHEET_LAYOUT_FEATURE,
    'module-spreadsheet-column-editor-v1', 'module-spreadsheet-workbook-tools-v1',
    'module-spreadsheet-column-visibility-v1', 'module-spreadsheet-column-paint-v1', 'module-spreadsheet-text-size-v1',
    'module-workspace-actions-v1', 'module-workspace-matrix-choices-v1', 'module-matrix-v1',
    'module-matrix-row-fields-v1', 'module-feedback-observers-v1', 'module-choice-bindings-v1',
    'module-choices-v2', 'module-fields-v2', 'module-runtime-directory-v1', 'module-feedback-triggers-v1', 'module-feedback-trigger-conditions-v1',
  ] },
  capabilities: ['host.documents', 'host.helpers', 'service.page.studio', 'state-feedback'],
  settings: [{ id: 'sampleData', label: 'Use sample devices', type: 'boolean', required: true, default: false }],
  matrix,
  actions: [{ id: 'camera-control', label: 'Cyanview', description: 'Named Cyanview routing and camera controls.',
    completion: 'response', completionAlternatives: ['local', 'state-confirmed'], timeoutMs: 120000, fields: [] }, ...controlActions],
  feedback: [{ id: 'camera-control', label: 'Cyanview', description: 'Camera selection and observed controller state.', fields: [] }],
  documents: documentDefinitions(),
  helpers: [{
    id: 'icmp-probe', label: 'IP discovery',
    variants: (['darwin', 'linux'] as const).flatMap(platform => (['arm64', 'x64'] as const).map(arch => ({ platform, arch, runtime: 'node' as const, nodeMajor: 22, entry: 'helpers/ping.mjs' }))),
    methods: [{ id: 'batch', readOnly: true, timeoutMs: 10000 }],
    readinessTimeoutMs: 5000, maxConcurrent: 4, memoryMb: 64,
  }],
  pages: [{ id: 'studio', label: 'Cyanview', icon: 'ui/logo.svg', layout: 'full-page', sections: [ModuleFrontendSectionSchema.parse({
    type: 'custom', id: 'frontend', label: 'Cyanview configuration', entry: 'ui/index.html',
    commands: ['read-plan', 'read-part', 'save-plan', 'save-begin', 'save-part', 'save-commit', 'send', 'send-begin', 'send-part', 'send-commit', 'scan', 'stop-scan', 'probe', 'find-rig', 'import-device', 'import-part', 'refresh', 'choice-catalogs', 'options', 'remi-state', 'remi-send', 'remi-route', 'camera-control-state', 'camera-control-mutate'].map(id => ({ id, label: id })),
  })] }],
});
