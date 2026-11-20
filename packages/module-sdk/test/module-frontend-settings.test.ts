import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { ModuleManifestSchema } from '../src/index.js'
import {
  createModuleFrontendClient,
  ModuleFrontendRequestSchema,
  type ModuleFrontendPort,
} from '../src/frontend.js'

const FEATURES = ['module-pages-v1', 'module-custom-pages-v1', 'module-frontend-settings-v1']
const manifest = (
  section: Record<string, unknown>,
  features = FEATURES,
  settings: unknown[] = [
    { id: 'port', label: 'Port', type: 'number', required: true, default: 9821 },
    { id: 'protocol', label: 'TSL version', type: 'text', required: true, default: '5.0' },
    { id: 'password', label: 'Password', type: 'text', required: false, default: '', secret: true },
  ],
) => ({
  formatVersion: 1,
  id: 'example-page-settings',
  name: 'Page settings',
  version: '1.0.0',
  apiVersion: 1,
  host: { minimumVersion: '2.3.1', requiredFeatures: features },
  configVersion: 1,
  entry: 'module.mjs',
  files: ['module.mjs', 'ui/index.html'],
  capabilities: ['service.page.setup'],
  actions: [],
  feedback: [],
  settings,
  pages: [
    {
      id: 'setup',
      label: 'Setup',
      sections: [
        {
          type: 'custom',
          id: 'app',
          label: 'Setup',
          entry: 'ui/index.html',
          commands: [],
          ...section,
        },
      ],
    },
  ],
})
const declared = (value: unknown) => {
  const section = ModuleManifestSchema.parse(value).pages?.[0]?.sections[0]
  return section?.type === 'custom' ? section.settings : undefined
}

it('lets a custom page declare which of its module settings it saves', () => {
  expect(declared(manifest({ settings: ['port', 'protocol'] }))).toEqual(['port', 'protocol'])
  // A page that declares none is unchanged, so every existing package still validates.
  expect(declared(manifest({}, ['module-pages-v1', 'module-custom-pages-v1']))).toBeUndefined()
})

it('requires the host feature, declared settings only, and never a secret', () => {
  expect(() =>
    ModuleManifestSchema.parse(
      manifest({ settings: ['port'] }, ['module-pages-v1', 'module-custom-pages-v1']),
    ),
  ).toThrow('module-frontend-settings-v1')
  expect(() => ModuleManifestSchema.parse(manifest({ settings: ['unknown'] }))).toThrow(
    "only the module's own declared settings",
  )
  expect(() => ModuleManifestSchema.parse(manifest({ settings: ['password'] }))).toThrow(
    'never a secret',
  )
  expect(() => ModuleManifestSchema.parse(manifest({ settings: ['port', 'port'] }))).toThrow()
  expect(() => ModuleManifestSchema.parse(manifest({ settings: [] }))).toThrow()
})

it('sends a settings request and settles on the host reply', async () => {
  const channel = new MessageChannel()
  const client = createModuleFrontendClient(frontendPort(channel.port1))
  const requests: unknown[] = []
  channel.port2.on('message', (value: { id: string }) => {
    requests.push(ModuleFrontendRequestSchema.parse(value))
    channel.port2.postMessage(
      requests.length === 1
        ? { type: 'result', id: value.id, value: null }
        : { type: 'error', id: value.id, message: 'This page did not declare that setting' },
    )
  })
  await expect(client.saveSettings({ port: 5727, protocol: '3.1' })).resolves.toBeNull()
  await expect(client.saveSettings({ bindAddress: '0.0.0.0' })).rejects.toThrow(
    'This page did not declare that setting',
  )
  expect(requests).toEqual([
    { id: 'request-1', operation: 'settings', values: { port: 5727, protocol: '3.1' } },
    { id: 'request-2', operation: 'settings', values: { bindAddress: '0.0.0.0' } },
  ])
  // An empty save is a mistake in the page, caught before anything is sent.
  expect(() => client.saveSettings({})).toThrow()
  client.dispose()
  channel.port2.close()
})

function frontendPort(port: MessagePort): ModuleFrontendPort {
  const listeners = new Map<(event: { data: unknown }) => void, (value: unknown) => void>()
  return {
    postMessage: (value) => {
      port.postMessage(value)
    },
    addEventListener(_type, listener) {
      const wrapped = (value: unknown) => {
        listener({ data: value })
      }
      listeners.set(listener, wrapped)
      port.on('message', wrapped)
    },
    removeEventListener(_type, listener) {
      const wrapped = listeners.get(listener)
      if (wrapped) port.off('message', wrapped)
    },
    start() {},
    close: () => {
      port.close()
    },
  }
}
