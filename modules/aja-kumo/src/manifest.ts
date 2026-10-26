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
    'host.router-groups',
    'service.refreshNames',
    'service.setDestinationLock',
    'service.recallSalvo',
    'service.routeCrosspoints',
    'service.interrogateRouteTargets',
    'service.selectDestination',
    'service.selectSource',
    'service.submitSelectSource',
    'service.take',
    'service.submitTake',
    'service.directRoute',
    'service.submitDirectRoute',
    'service.submitDirectRouteTracked',
    'service.watch',
    'service.unwatch',
  ],
  settings: [],
  actions: [
    {
      id: 'aja-kumo.select-source',
      label: 'select source',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.select-destination',
      label: 'select destination',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.take',
      label: 'take',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.toggle-group-enabled',
      label: 'toggle group enabled',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.direct-route',
      label: 'direct route',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.refresh-names',
      label: 'refresh names',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'aja-kumo.recall-salvo',
      label: 'recall salvo',
      description:
        'Preserves saved IDs, grouped selections, level behavior and protocol completion boundaries.',
      completion: 'submitted',
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [],
})
