import { ModuleMatrixSchema } from '@hubble/module-sdk'
import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export const matrix = ModuleMatrixSchema.parse({
  id: 'counter',
  label: 'Local counter',
  actionId: 'apply',
  feedbackId: 'level',
  primaryField: 'actionType',
  fields: [
    {
      id: 'actionType',
      label: 'Mode',
      type: 'choice',
      default: 'count',
      choices: [
        { value: 'count', label: 'Count' },
        { value: 'percent', label: 'Percentage' },
      ],
    },
    {
      id: 'module.value',
      label: 'Value',
      type: 'number',
      default: 1,
      required: true,
      integer: true,
      min: 0,
      max: 8,
      formula: true,
      rules: [{ when: [{ field: 'actionType', values: ['percent'] }], set: { max: 100 } }],
    },
    {
      id: 'module.colors',
      label: 'Feedback colours',
      type: 'color',
      colorMode: 'pair',
      default: '#333333 | #16A34A',
    },
  ],
})

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  configVersion: 1,
  savedActionVersion: 2,
  host: {
    minimumVersion: '2.0.11',
    requiredFeatures: [
      'module-matrix-v1',
      'module-feedback-observers-v1',
      'module-matrix-row-fields-v1',
      'module-saved-actions-v1',
      'module-matrix-migrations-v1',
    ],
  },
  capabilities: [],
  settings: [],
  matrix,
  actions: [
    {
      id: 'apply',
      label: 'Apply local value',
      description: 'Records an in-memory value; never sends device commands.',
      completion: 'local',
      fields: [],
      timeoutMs: 1000,
    },
  ],
  feedback: [
    {
      id: 'level',
      label: 'Level',
      description: 'Whether the row is above half its declared range.',
      fields: [],
    },
  ],
})
