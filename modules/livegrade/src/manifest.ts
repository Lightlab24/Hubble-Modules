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
    'state-feedback',
    'host.livegrade',
    'service.selectSlot',
    'service.requestAccessibilityPermission',
  ],
  settings: [],
  actions: [
    {
      id: 'livegrade.select-slot',
      label: 'Select Slot',
      description:
        'Select a slot using the existing signed native helper and verify its reported selection.',
      completion: 'state-confirmed',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
