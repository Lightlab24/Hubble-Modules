import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { z } from 'zod'

import { ModuleFilePathSchema, ModuleManifestSchema, type ModuleManifest } from './index.js'

export const MAX_MODULE_ARCHIVE_BYTES = 16 * 1_024 * 1_024
export const MAX_MODULE_EXPANDED_BYTES = 32 * 1_024 * 1_024
export const MAX_MODULE_FILE_BYTES = 8 * 1_024 * 1_024

const ArchiveSchema = z.strictObject({
  format: z.literal('hubble-module'),
  formatVersion: z.literal(1),
  manifest: ModuleManifestSchema,
  files: z
    .array(
      z.strictObject({
        path: ModuleFilePathSchema,
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        data: z.string().max(Math.ceil(MAX_MODULE_FILE_BYTES / 3) * 4),
      }),
    )
    .min(1)
    .max(128),
})

export interface InspectedModulePackage {
  readonly manifest: ModuleManifest
  readonly digest: string
  readonly archiveBytes: number
  readonly expandedBytes: number
  readonly files: ReadonlyMap<string, Buffer>
  /** Local inspection does not establish a publisher's identity. */
  readonly origin: 'local'
}

export function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

export function createModulePackage(
  rawManifest: unknown,
  contents: ReadonlyMap<string, Buffer>,
): Buffer {
  const manifest = ModuleManifestSchema.parse(rawManifest)
  if (contents.size !== manifest.files.length)
    throw new Error('Package files must exactly match the manifest')
  let totalBytes = 0
  const files = [...manifest.files].sort().map((filePath) => {
    const data = contents.get(filePath)
    if (data === undefined) throw new Error(`Missing declared file: ${filePath}`)
    totalBytes += data.byteLength
    if (data.byteLength > MAX_MODULE_FILE_BYTES || totalBytes > MAX_MODULE_EXPANDED_BYTES) {
      throw new Error('Module file size limit exceeded')
    }
    return { path: filePath, data: data.toString('base64'), sha256: sha256(data) }
  })
  const document = JSON.stringify({ format: 'hubble-module', formatVersion: 1, manifest, files })
  if (Buffer.byteLength(document) > MAX_MODULE_EXPANDED_BYTES)
    throw new Error('Module expanded size limit exceeded')
  const archive = gzipSync(document, { level: 9 })
  if (archive.byteLength > MAX_MODULE_ARCHIVE_BYTES)
    throw new Error('Module archive size limit exceeded')
  return archive
}

/** Validate data without importing JavaScript, extracting paths, or running install scripts. */
export function inspectModulePackage(archive: Buffer): InspectedModulePackage {
  if (archive.byteLength > MAX_MODULE_ARCHIVE_BYTES)
    throw new Error('Module archive size limit exceeded')
  const raw = gunzipSync(archive, { maxOutputLength: MAX_MODULE_EXPANDED_BYTES })
  const document = ArchiveSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
  )
  const files = new Map<string, Buffer>()
  const foldedPaths = new Set<string>()
  let expandedBytes = 0
  for (const file of document.files) {
    if (foldedPaths.has(file.path.toLowerCase())) throw new Error('Duplicate package path')
    foldedPaths.add(file.path.toLowerCase())
    const data = Buffer.from(file.data, 'base64')
    if (data.toString('base64') !== file.data) throw new Error('Invalid base64 file data')
    expandedBytes += data.byteLength
    if (data.byteLength > MAX_MODULE_FILE_BYTES || expandedBytes > MAX_MODULE_EXPANDED_BYTES) {
      throw new Error('Module file size limit exceeded')
    }
    if (sha256(data) !== file.sha256) throw new Error(`File digest mismatch: ${file.path}`)
    files.set(file.path, data)
  }
  if (
    files.size !== document.manifest.files.length ||
    document.manifest.files.some((file) => !files.has(file))
  ) {
    throw new Error('Package files must exactly match the manifest')
  }
  // Files are portable data. The host must additionally verify a signed catalog
  // entry before treating a package as official, and snapshot before execution.
  return Object.freeze({
    manifest: document.manifest,
    digest: sha256(archive),
    archiveBytes: archive.byteLength,
    expandedBytes,
    files,
    origin: 'local',
  })
}
