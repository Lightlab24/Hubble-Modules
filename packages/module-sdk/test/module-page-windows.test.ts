import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { ModuleManifestSchema } from '../src/index.js'
import {
  connectModuleFrontend,
  createModuleFrontendClient,
  ModuleFrontendRequestSchema,
  type ModuleFrontendPort,
  type ModuleFrontendWindow,
} from '../src/frontend.js'

const FEATURES = ['module-pages-v1', 'module-custom-pages-v1', 'module-page-windows-v1']
const manifest = (section: Record<string, unknown>, features = FEATURES) => ({
  formatVersion: 1,
  id: 'example-page-windows',
  name: 'Page windows',
  version: '1.0.0',
  apiVersion: 1,
  host: { minimumVersion: '2.3.1', requiredFeatures: features },
  configVersion: 1,
  entry: 'module.mjs',
  files: ['module.mjs', 'ui/index.html'],
  capabilities: ['service.page.cameras'],
  actions: [],
  feedback: [],
  settings: [],
  pages: [
    {
      id: 'cameras',
      label: 'Cameras',
      sections: [
        {
          type: 'custom',
          id: 'app',
          label: 'Cameras',
          entry: 'ui/index.html',
          commands: [],
          ...section,
        },
      ],
    },
  ],
})
const windows = (value: unknown) => {
  const section = ModuleManifestSchema.parse(value).pages?.[0]?.sections[0]
  return section?.type === 'custom' ? section.windows : undefined
}

it('lets a custom page declare that it is built for several windows', () => {
  expect(windows(manifest({ windows: true }))).toBe(true)
  // A page that does not declare it is unchanged, so every existing package still validates.
  expect(windows(manifest({}, ['module-pages-v1', 'module-custom-pages-v1']))).toBeUndefined()
})

it('requires the host feature, and the declaration is only ever true', () => {
  expect(() =>
    ModuleManifestSchema.parse(
      manifest({ windows: true }, ['module-pages-v1', 'module-custom-pages-v1']),
    ),
  ).toThrow('module-page-windows-v1')
  expect(() => ModuleManifestSchema.parse(manifest({ windows: false }))).toThrow()
  expect(() => ModuleManifestSchema.parse(manifest({ windows: 'camera-3' }))).toThrow()
})

it('asks Hubble for a window by a view and a one-line title, and renames its own', async () => {
  const channel = new MessageChannel()
  const client = createModuleFrontendClient(frontendPort(channel.port1), {
    view: 'camera-3',
    canOpen: true,
  })
  expect(client.view).toBe('camera-3')
  expect(client.canOpenWindows).toBe(true)
  const asked: unknown[] = []
  channel.port2.on('message', (value: { id: string }) => {
    asked.push(value)
    channel.port2.postMessage({ type: 'result', id: value.id, value: null })
  })
  await expect(client.openWindow('camera-4', 'Camera 4')).resolves.toBeUndefined()
  await expect(client.setWindowTitle(' Camera 3 Wide ')).resolves.toBeUndefined()
  expect(asked).toEqual([
    { id: 'request-1', operation: 'open-window', view: 'camera-4', title: 'Camera 4' },
    { id: 'request-2', operation: 'window-title', title: 'Camera 3 Wide' },
  ])
  // Nothing leaves the page for a view or title Hubble would not take.
  expect(() => client.openWindow('', 'Camera 4')).toThrow()
  expect(() => client.openWindow('x'.repeat(129), 'Camera 4')).toThrow()
  expect(() => client.openWindow('camera-4', 'Two\nlines')).toThrow()
  expect(() => client.setWindowTitle('x'.repeat(81))).toThrow()
  expect(asked).toHaveLength(2)
  // A window is named and found by a view; no address, size or place is part of the request.
  expect(
    ModuleFrontendRequestSchema.safeParse({
      id: 'r',
      operation: 'open-window',
      view: 'camera-4',
      title: 'Camera 4',
      url: 'https://example.com/',
    }).success,
  ).toBe(false)
  client.dispose()
  channel.port2.close()
})

it('reports Hubble refusing a window as a failed request', async () => {
  const channel = new MessageChannel()
  const client = createModuleFrontendClient(frontendPort(channel.port1))
  // Opened by a Hubble from before windows, or with nothing said: the whole page, no windows.
  expect(client.view).toBeNull()
  expect(client.canOpenWindows).toBe(false)
  channel.port2.on('message', (value: { id: string }) => {
    channel.port2.postMessage({
      type: 'error',
      id: value.id,
      message: 'Windows are not available here',
    })
  })
  await expect(client.openWindow('camera-3', 'Camera 3')).rejects.toThrow(
    'Windows are not available here',
  )
  client.dispose()
  channel.port2.close()
})

it('reads where the page is shown from what Hubble sends with the port', async () => {
  const connect = async (shown: unknown) => {
    const channel = new MessageChannel()
    const listeners = new Set<
      (event: { data: unknown; source: unknown; ports: readonly ModuleFrontendPort[] }) => void
    >()
    const parent = {
      postMessage: (message: unknown) => {
        const { id } = message as { id: string }
        queueMicrotask(() => {
          for (const listener of listeners)
            listener({
              data: {
                type: 'hubble.module.frontend.connect.v1',
                id,
                ...(shown === undefined ? {} : { window: shown }),
              },
              source: parent,
              ports: [frontendPort(channel.port1)],
            })
        })
      },
    }
    const target: ModuleFrontendWindow = {
      parent,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    }
    const client = await connectModuleFrontend(target)
    const result = { view: client.view, canOpenWindows: client.canOpenWindows }
    client.dispose()
    channel.port2.close()
    return result
  }
  expect(await connect({ view: 'camera-3', canOpen: true })).toEqual({
    view: 'camera-3',
    canOpenWindows: true,
  })
  expect(await connect({ view: null, canOpen: false })).toEqual({
    view: null,
    canOpenWindows: false,
  })
  // An older Hubble sends nothing, and anything malformed counts as nothing.
  expect(await connect(undefined)).toEqual({ view: null, canOpenWindows: false })
  expect(await connect({ view: 7, canOpen: 'yes' })).toEqual({ view: null, canOpenWindows: false })
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
