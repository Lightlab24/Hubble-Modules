import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.0',
    requiredFeatures: ['host-services-v1'],
  },
  configVersion: 1,
  capabilities: [
    'persistent-connection',
    'state-feedback',
    'service.toggleAll',
    'service.toggleSlot',
    'service.toggleTimer',
    'service.setTimerMinutes',
  ],
  settings: [],
  actions: [
    {
      id: 'lightencode.record-toggle-all',
      label: 'record toggle all',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'state-confirmed',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'lightencode.record-toggle-slot',
      label: 'record toggle slot',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'state-confirmed',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'lightencode.timer-toggle',
      label: 'timer toggle',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'state-confirmed',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'lightencode.timer-set-minutes',
      label: 'timer set minutes',
      description:
        'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'state-confirmed',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
