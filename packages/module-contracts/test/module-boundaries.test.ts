import { build } from 'esbuild'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const names = readdirSync(path.join(root, 'modules')).sort()

describe('independent official module source', () => {
  it('keeps supported package identities unique at initial version 1.0.0', () => {
    const manifests = names.map((name) =>
      JSON.parse(readFileSync(path.join(root, 'modules', name, 'package.json'), 'utf8')),
    )
    expect(new Set(manifests.map((value) => value.hubble.id)).size).toBe(names.length)
    expect(manifests.every((value) => value.version === '1.0.0')).toBe(true)
  })
  it.each(names)('%s bundles only its own module and public shared code', async (name) => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [path.join(root, 'modules', name, 'src/index.ts')],
      write: false,
      bundle: true,
      metafile: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['bufferutil', 'utf-8-validate'],
    })
    for (const input of Object.keys(result.metafile!.inputs)) {
      const resolved = path.resolve(root, input)
      expect(resolved.startsWith(root), input).toBe(true)
      expect(resolved.includes('/apps/hubble-'), input).toBe(false)
      expect(resolved.includes('/packages/official-module-runtime/'), input).toBe(false)
      if (resolved.startsWith(path.join(root, 'modules') + path.sep))
        expect(resolved.startsWith(path.join(root, 'modules', name) + path.sep), input).toBe(
          true,
        )
    }
  })
})
