import { defineModuleManifest } from '@hubble/module-sdk/authoring'
import { matrix } from './matrix.js'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.11',
    requiredFeatures: [
      'host-services-v1',
      'module-fields-v2',
      'module-matrix-v1',
      'module-feedback-observers-v1',
      'module-matrix-context-v1',
    ],
  },
  configVersion: 1,
  matrix,
  capabilities: [
    'persistent-connection',
    'state-feedback',
    'service.selectFeed',
    'service.selectFeedByFeedId',
    'service.selectFeedByNumber',
  ],
  settings: [
    {
      id: 'host',
      label: 'Host',
      type: 'text',
      default: '127.0.0.1',
      required: true,
      description: 'Hostname, IPv4 address, or bracketed IPv6 address of CyanView Studio.',
    },
    {
      id: 'port',
      label: 'Port',
      type: 'number',
      default: 4173,
      required: true,
      integer: true,
      min: 1,
      max: 65535,
    },
    {
      id: 'requestTimeoutMs',
      label: 'Request timeout (ms)',
      type: 'number',
      default: 1500,
      required: true,
      integer: true,
      min: 100,
      max: 4000,
    },
  ],
  actions: [
    {
      id: 'matrix',
      label: 'Select feed',
      description: 'Uses the fields and method selected in this Matrix row.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-studio.select-feed',
      label: 'Select camera ID',
      description: 'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [{ id: 'cameraId', label: 'Camera ID', type: 'text', required: true, default: '' }],
    },
    {
      id: 'cyanview-studio.select-feed-id',
      label: 'Select feed ID',
      description: 'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [
        {
          id: 'feedId',
          label: 'Feed ID',
          type: 'number',
          required: true,
          integer: true,
          default: 0,
        },
      ],
    },
    {
      id: 'cyanview-studio.select-feed-number',
      label: 'Select feed number',
      description: 'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      timeoutMs: 30000,
      fields: [
        {
          id: 'feedNumber',
          label: 'Feed number',
          type: 'number',
          required: true,
          integer: true,
          min: 1,
          default: 1,
        },
      ],
    },
  ],
  feedback: [
    {
      id: 'matrix',
      label: 'Feed request',
      description:
        'Request completion is reported by the action result; selection is not inferred.',
      fields: [],
    },
  ],
})
