import type { ModuleHostServices } from './host-services.js'
import type { ModuleDocumentRequest, ModuleDocumentSnapshot } from './documents.js'
import { ModuleDocumentValueSchema, ModuleDocumentValidationError } from './documents.js'
import type { ModuleJsonValue } from './index.js'

export class ModuleDocumentConflictError extends Error {
  constructor(readonly document: ModuleDocumentSnapshot) {
    super('Document changed; refresh before saving')
    this.name = 'ModuleDocumentConflictError'
  }
}

/** Access only documents declared by this module, in this module instance's workspace. */
export function createModuleDocumentClient(services: ModuleHostServices) {
  const request = async (
    input: Exclude<ModuleDocumentRequest, { method: 'list' }>,
    signal?: AbortSignal,
  ): Promise<ModuleDocumentSnapshot> => {
    const result = await services.request('documents', 1, input, signal)
    if (result.status === 'conflict') throw new ModuleDocumentConflictError(result.document)
    if (result.status === 'invalid')
      throw new ModuleDocumentValidationError(result.message, result.issues)
    if (result.status !== 'document') throw new Error('Unexpected document response')
    return result.document
  }
  return {
    async list(signal?: AbortSignal) {
      const result = await services.request('documents', 1, { method: 'list' }, signal)
      if (result.status !== 'catalog') throw new Error('Unexpected document catalog')
      return result.documents
    },
    read: (id: string, signal?: AbortSignal) => request({ method: 'read', id }, signal),
    write: (
      document: Pick<ModuleDocumentSnapshot, 'id' | 'revision'>,
      value: ModuleJsonValue,
      signal?: AbortSignal,
    ) =>
      request(
        {
          method: 'write',
          id: document.id,
          expectedRevision: document.revision,
          value: ModuleDocumentValueSchema.parse(value),
        },
        signal,
      ),
    reset: (document: Pick<ModuleDocumentSnapshot, 'id' | 'revision'>, signal?: AbortSignal) =>
      request({ method: 'reset', id: document.id, expectedRevision: document.revision }, signal),
    history: (
      document: Pick<ModuleDocumentSnapshot, 'id' | 'revision'>,
      intent: 'undo' | 'redo',
      signal?: AbortSignal,
    ) =>
      request(
        { method: 'history', id: document.id, expectedRevision: document.revision, intent },
        signal,
      ),
    async *watch(id: string, signal: AbortSignal): AsyncGenerator<ModuleDocumentSnapshot> {
      let document = await request({ method: 'read', id }, signal)
      yield document
      while (!signal.aborted) {
        const next = await request(
          { method: 'watch', id, afterRevision: document.revision },
          signal,
        )
        if (JSON.stringify(next) !== JSON.stringify(document)) {
          document = next
          yield document
        }
      }
    },
  }
}
