import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { ModuleManifestSchema } from '../src/index.js'
import { createModuleFrontendClient, type ModuleFrontendPort } from '../src/frontend.js'

const FEATURES = ['module-pages-v1', 'module-custom-pages-v1', 'module-frontend-restart-v1']
const manifest = (section: Record<string, unknown>, features = FEATURES) => ({
  formatVersion: 1,
  id: 'example-page-restart',
  name: 'Page restart',
  version: '1.0.0',
  apiVersion: 1,
  host: { minimumVersion: '2.3.1', requiredFeatures: features },
  configVersion: 1,
  entry: 'module.mjs',
  files: ['module.mjs', 'ui/index.html'],
  capabilities: ['service.page.setup'],
  actions: [],
  feedback: [],
  settings: [],
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
const restart = (value: unknown) => {
  const section = ModuleManifestSchema.parse(value).pages?.[0]?.sections[0]
  return section?.type === 'custom' ? section.restart : undefined
}

it('lets a custom page ask to stay open while its module restarts', () => {
  expect(restart(manifest({ restart: 'keep-open' }))).toBe('keep-open')
  // A page that does not ask is unchanged, so every existing package still validates.
  expect(restart(manifest({}, ['module-pages-v1', 'module-custom-pages-v1']))).toBeUndefined()
})

it('requires the host feature and knows no other way to restart', () => {
  expect(() =>
    ModuleManifestSchema.parse(
      manifest({ restart: 'keep-open' }, ['module-pages-v1', 'module-custom-pages-v1']),
    ),
  ).toThrow('module-frontend-restart-v1')
  expect(() => ModuleManifestSchema.parse(manifest({ restart: 'reload' }))).toThrow()
  expect(() => ModuleManifestSchema.parse(manifest({ restart: true }))).toThrow()
})

it('tells the page each time its module has restarted, until it stops listening', async () => {
  const channel = new MessageChannel()
  const client = createModuleFrontendClient(frontendPort(channel.port1))
  let heard = 0
  const stop = client.onRestart(() => heard++)
  // A request the stopped run never answered fails with the host's word for it; the page stays.
  channel.port2.on('message', (value: { id: string }) => {
    channel.port2.postMessage({ type: 'error', id: value.id, message: 'Module is restarting' })
    channel.port2.postMessage({ type: 'restarted' })
  })
  await expect(client.call('read')).rejects.toThrow('Module is restarting')
  await expect.poll(() => heard).toBe(1)
  channel.port2.postMessage({ type: 'restarted' })
  await expect.poll(() => heard).toBe(2)
  // The page is still open and still answered.
  channel.port2.removeAllListeners('message')
  channel.port2.on('message', (value: { id: string }) => {
    channel.port2.postMessage({ type: 'result', id: value.id, value: 'from the new run' })
  })
  await expect(client.call('read')).resolves.toBe('from the new run')
  stop()
  channel.port2.postMessage({ type: 'restarted' })
  await expect(client.call('read')).resolves.toBe('from the new run')
  expect(heard).toBe(2)
  client.dispose()
  expect(() => client.onRestart(() => undefined)).toThrow('Module page closed')
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
