import { randomUUID } from 'node:crypto'
import { z } from 'zod'

// Internal adapters keep Maps and page-sized protocol state out of the public SDK state bag.
// Chunks are ordered over the same IPC channel and published atomically on completion.
const CHUNK_SIZE = 128 * 1024
const MAX_CHUNKS = 128
const ChunkSchema = z.strictObject({
  id: z.uuid(),
  index: z
    .int()
    .min(0)
    .max(MAX_CHUNKS - 1),
  count: z.int().min(1).max(MAX_CHUNKS),
  text: z.string().max(CHUNK_SIZE),
})
const MapEntriesSchema = z.array(z.tuple([z.number().int().nonnegative(), z.unknown()]))

export function encodeModuleData(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Map ? { $hubbleMap: [...item] } : item,
  )
}
export function decodeModuleData(value: string): unknown {
  return JSON.parse(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && '$hubbleMap' in item) {
      const entries = MapEntriesSchema.parse(item.$hubbleMap)
      return new Map(entries)
    }
    return item
  })
}
export function publishModuleData(
  publish: (
    channel: string,
    value: { id: string; index: number; count: number; text: string },
  ) => void,
  channel: string,
  value: unknown,
): void {
  const encoded = encodeModuleData(value)
  const count = Math.max(1, Math.ceil(encoded.length / CHUNK_SIZE))
  if (count > MAX_CHUNKS)
    throw new Error('Module observation exceeds the bounded snapshot capacity')
  const id = randomUUID()
  for (let index = 0; index < count; index++)
    publish(channel, {
      id,
      index,
      count,
      text: encoded.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
    })
}
export class ModuleDataAssembler {
  #pending: { id: string; count: number; parts: string[] } | undefined
  accept(value: unknown): { complete: false } | { complete: true; value: unknown } {
    const chunk = ChunkSchema.parse(value)
    if (chunk.index === 0) this.#pending = { id: chunk.id, count: chunk.count, parts: [] }
    const pending = this.#pending
    if (
      !pending ||
      chunk.id !== pending.id ||
      chunk.count !== pending.count ||
      chunk.index !== pending.parts.length
    ) {
      this.#pending = undefined
      throw new Error('Module snapshot chunks are out of sequence')
    }
    pending.parts.push(chunk.text)
    if (pending.parts.length !== pending.count) return { complete: false }
    this.#pending = undefined
    return { complete: true, value: decodeModuleData(pending.parts.join('')) }
  }
}

/** Coalesce replaceable observations in one event-loop turn; command receipts stay immediate. */
export function createModuleDataPublisher(publish: Parameters<typeof publishModuleData>[0]) {
  const pending = new Map<string, unknown>()
  let queued = false,
    closed = false
  return {
    publish(channel: string, value: unknown) {
      if (closed) return
      pending.set(channel, value)
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (closed) return
        const batch = [...pending]
        pending.clear()
        for (const [name, snapshot] of batch) publishModuleData(publish, name, snapshot)
      })
    },
    close() {
      closed = true
      pending.clear()
    },
  }
}
