import { defineModuleManifest } from '@hubble/module-sdk/authoring'
import { matrix } from './matrix.js'

const REFUSED =
  'CyanView RCP only switches cameras, so this refuses and sends nothing. Kept so saved rows still load.'

export default defineModuleManifest({
  formatVersion: 1,
  apiVersion: 1,
  host: {
    minimumVersion: '2.0.11',
    requiredFeatures: [
      'host-services-v1',
      'module-exchange-v1',
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
    'service.selectCamera',
  ],
  exchange: {
    data: [{ id: 'connection', label: 'RCP connection', version: 1, query: true }],
  },
  settings: [
    {
      id: 'host',
      label: 'Host',
      type: 'text',
      required: true,
      default: '127.0.0.1',
      description: 'Hostname, IPv4 address, or bracketed IPv6 address.',
    },
    {
      id: 'port',
      label: 'Port',
      type: 'number',
      required: true,
      default: 1883,
      integer: true,
      min: 1,
      max: 65535,
    },
    {
      id: 'requestTimeoutMs',
      label: 'Request timeout (ms)',
      type: 'number',
      required: true,
      default: 1500,
      integer: true,
      min: 100,
      max: 4000,
    },
  ],
  actions: [
    {
      id: 'matrix',
      label: 'Camera control',
      description: 'Switches the RCP panel to the camera in this Matrix row.',
      completion: 'response',
      completionAlternatives: ['state-confirmed', 'local'],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    ...(['start-enabled-cameras', 'stop-enabled-cameras'] as const).map((command) => ({
      id: `cyanview-rcp.${command}`,
      label: command === 'start-enabled-cameras' ? 'Start enabled cameras' : 'Stop enabled cameras',
      description: REFUSED,
      completion: 'state-confirmed' as const,
      completionAlternatives: ['local' as const],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    })),
    {
      id: 'cyanview-rcp.select-camera',
      label: 'select camera',
      description: 'Preserves the existing saved action contract and protocol completion boundary.',
      completion: 'response',
      completionAlternatives: ['state-confirmed', 'local'],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-rcp.record-camera',
      label: 'record camera',
      description: REFUSED,
      completion: 'response',
      completionAlternatives: ['state-confirmed', 'local'],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
    {
      id: 'cyanview-rcp.record-group-all',
      label: 'record group all',
      description: REFUSED,
      completion: 'response',
      completionAlternatives: ['state-confirmed', 'local'],
      timeoutMs: 120000,
      fields: [],
      legacy: true,
    },
  ],
  feedback: [
    {
      id: 'matrix',
      label: 'Selected camera',
      description: 'Observed RCP camera selection.',
      fields: [],
    },
  ],
})
