import { defineModuleManifest } from '@hubble/module-sdk/authoring'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.0',
    requiredFeatures: ['host-services-v1'],
  },
  configVersion: 1,
  capabilities: ['host.keyboard'],
  settings: [],
  actions: [
    {
      id: 'keyboard.send-shortcut',
      label: 'keyboard.send shortcut',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'response',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'system.activate-application',
      label: 'system.activate application',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'response',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'system.open-application',
      label: 'system.open application',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'response',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'system.select-menu-item',
      label: 'system.select menu item',
      description: 'Preserves the saved action contract and reports only observed completion.',
      completion: 'response',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
