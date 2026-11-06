import { z } from 'zod'

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/u)
/** Static browser assets live under ui/; backend files are never served to a page. */
export const ModuleFrontendSectionSchema = z
  .strictObject({
    type: z.literal('custom'),
    id: Id,
    label: z.string().trim().min(1).max(160),
    entry: z
      .string()
      .max(240)
      .regex(/^ui\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.html$/u),
    height: z.int().min(48).max(1600).default(560),
    commands: z
      .array(
        z.strictObject({
          id: Id,
          label: z.string().trim().min(1).max(160),
        }),
      )
      .max(128),
  })
  .refine(
    (value) => new Set(value.commands.map((command) => command.id)).size === value.commands.length,
    'Duplicate custom page command ID',
  )

export const ModuleFrontendTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u)
export const ModuleFrontendReadySchema = z.strictObject({
  type: z.literal('hubble.module.frontend.ready.v1'),
  id: z.string().regex(/^[a-f0-9]{32}$/u),
})
export const ModuleFrontendValueSchema = z
  .json()
  .refine(
    (value) => JSON.stringify(value).length <= 262_144,
    'Custom page payload exceeds 256K characters',
  )
export const ModuleFrontendRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    id: Id,
    operation: z.literal('call'),
    commandId: Id,
    value: ModuleFrontendValueSchema,
  }),
  z.strictObject({ id: Id, operation: z.literal('state') }),
])
export const ModuleFrontendReplySchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('result'), id: Id, value: ModuleFrontendValueSchema }),
  z.strictObject({ type: z.literal('error'), id: Id, message: z.string().max(1000) }),
  z.strictObject({ type: z.literal('state'), value: ModuleFrontendValueSchema }),
  z.strictObject({ type: z.literal('closed'), message: z.string().max(1000) }),
])
export type ModuleFrontendSection = z.infer<typeof ModuleFrontendSectionSchema>
export type ModuleFrontendValue = z.infer<typeof ModuleFrontendValueSchema>

/** Structural port type keeps the public SDK usable in both browser and Node builds. */
export interface ModuleFrontendPort {
  postMessage(value: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  start(): void
  close(): void
}

export interface ModuleFrontendWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void }
  addEventListener(
    type: 'message',
    listener: (event: {
      data: unknown
      source: unknown
      ports: readonly ModuleFrontendPort[]
    }) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: {
      data: unknown
      source: unknown
      ports: readonly ModuleFrontendPort[]
    }) => void,
  ): void
}

/** Call in the package's browser entry. Only the containing host may supply the port. */
export function connectModuleFrontend(
  target: ModuleFrontendWindow,
  signal?: AbortSignal,
): Promise<ReturnType<typeof createModuleFrontendClient>> {
  return new Promise((resolve, reject) => {
    // getRandomValues also works on remote HTTP dashboards, where randomUUID is unavailable.
    const handshakeId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const finish = () => {
      clearInterval(retry)
      clearTimeout(timeout)
      target.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      finish()
      reject(new Error('Module page connection cancelled'))
    }
    const receive = (event: {
      data: unknown
      source: unknown
      ports: readonly ModuleFrontendPort[]
    }) => {
      const data = event.data as { type?: unknown; id?: unknown } | null
      if (
        event.source !== target.parent ||
        data?.type !== 'hubble.module.frontend.connect.v1' ||
        data.id !== handshakeId ||
        event.ports.length !== 1
      )
        return
      const port = event.ports[0]
      if (!port) return
      finish()
      resolve(createModuleFrontendClient(port))
    }
    const ready = () => {
      target.parent.postMessage({ type: 'hubble.module.frontend.ready.v1', id: handshakeId }, '*')
    }
    const retry = setInterval(ready, 250)
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('Hubble page bridge unavailable'))
    }, 15_000)
    target.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else ready()
  })
}

export function createModuleFrontendClient(port: ModuleFrontendPort) {
  let sequence = 0
  let closed = false
  const pending = new Map<
    string,
    {
      resolve(value: ModuleFrontendValue): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const listeners = new Set<(state: ModuleFrontendValue) => void>()
  let latest: ModuleFrontendValue | undefined
  const dispose = (message = 'Module page closed') => {
    if (closed) return
    closed = true
    port.removeEventListener('message', receive)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error(message))
    }
    pending.clear()
    listeners.clear()
    port.close()
  }
  const receive = (event: { data: unknown }) => {
    const parsed = ModuleFrontendReplySchema.safeParse(event.data)
    if (!parsed.success || closed) return
    const reply = parsed.data
    if (reply.type === 'closed') {
      dispose(reply.message)
      return
    }
    if (reply.type === 'state') {
      latest = reply.value
      for (const listener of listeners) listener(reply.value)
      return
    }
    const item = pending.get(reply.id)
    if (!item) return
    pending.delete(reply.id)
    clearTimeout(item.timer)
    if (reply.type === 'error') item.reject(new Error(reply.message))
    else item.resolve(reply.value)
  }
  port.addEventListener('message', receive)
  port.start()
  const request = (
    input:
      | { operation: 'state' }
      | { operation: 'call'; commandId: string; value: ModuleFrontendValue },
  ) => {
    if (closed) return Promise.reject(new Error('Module page closed'))
    if (pending.size >= 32) return Promise.reject(new Error('Too many pending page requests'))
    const id = `request-${String(++sequence)}`
    const value = ModuleFrontendRequestSchema.parse({ id, ...input })
    return new Promise<ModuleFrontendValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Module page request timed out'))
      }, 120_000)
      pending.set(id, { resolve, reject, timer })
      try {
        port.postMessage(value)
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(
          error instanceof Error
            ? error
            : new Error('Module page request failed', { cause: error }),
        )
      }
    })
  }
  return {
    call: (commandId: string, value: ModuleFrontendValue = null) =>
      request({ operation: 'call', commandId, value }),
    state: () => request({ operation: 'state' }),
    subscribe(listener: (state: ModuleFrontendValue) => void) {
      if (closed) throw new Error('Module page closed')
      listeners.add(listener)
      if (latest !== undefined) listener(latest)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose,
  }
}
