import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { ModuleManifestSchema, type ModuleManifest } from './index.js'
import { MAX_MODULE_EXPANDED_BYTES, MAX_MODULE_FILE_BYTES, createModulePackage } from './package.js'

export async function readModuleProject(
  directory: string,
): Promise<{ root: string; manifest: ModuleManifest; files: ReadonlyMap<string, Buffer> }> {
  const sourceRoot = await realpath(path.resolve(directory))
  let root = sourceRoot
  try {
    const source = await lstat(path.join(sourceRoot, 'src', 'index.ts'))
    if (source.isFile()) {
      root = path.join(sourceRoot, 'dist')
      const output = await lstat(root)
      if (!output.isDirectory() || output.isSymbolicLink())
        throw new Error('Expected a regular built dist directory')
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    if (root !== sourceRoot) throw new Error('Build this TypeScript module before validation, import or packaging')
  }
  const manifest = ModuleManifestSchema.parse(
    JSON.parse(
      (await readBoundedModuleFile(path.join(root, 'hubble-module.json'), 262_144)).toString(
        'utf8',
      ),
    ),
  )
  const files = new Map<string, Buffer>()
  let total = 0
  for (const relative of manifest.files) {
    let current = root
    for (const part of relative.split('/')) {
      current = path.join(current, part)
      if ((await lstat(current)).isSymbolicLink())
        throw new Error('Linked package content is not supported')
    }
    if (!(await realpath(current)).startsWith(`${root}${path.sep}`))
      throw new Error('Package file escapes the project')
    const data = await readBoundedModuleFile(current, MAX_MODULE_FILE_BYTES)
    total += data.byteLength
    if (total > MAX_MODULE_EXPANDED_BYTES) throw new Error('Module expanded size limit exceeded')
    files.set(relative, data)
  }
  return { root: sourceRoot, manifest, files }
}
export async function snapshotModuleProject(
  directory: string,
): Promise<{ root: string; archive: Buffer }> {
  const project = await readModuleProject(directory)
  return { root: project.root, archive: createModulePackage(project.manifest, project.files) }
}
export async function readBoundedModuleFile(file: string, max: number): Promise<Buffer> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > max)
    throw new Error('Expected a bounded regular module file')
  const data = await readFile(file)
  if (data.byteLength > max) throw new Error('Module file exceeds size limit')
  return data
}
