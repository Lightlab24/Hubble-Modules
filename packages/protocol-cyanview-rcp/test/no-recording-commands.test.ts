import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CyanViewRcpConnectionManager, RcpSession } from '../src/index.js'

const here = import.meta.dirname
const root = path.resolve(here, '../../..')
const builtModule = path.join(root, 'modules/cyanview-rcp/dist/module.mjs')
const forbidden = ['camgroup', 'action/set/keyboard', 'RecToggle']

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return sources(file)
      return entry.name.endsWith('.ts') ? [file] : []
    }),
  )
  return files.flat()
}

describe('the shared RCP protocol has no recording commands', () => {
  it.each(['recordCamera', 'recordGroupAll', 'sendCameraCommand'])('%s is gone', (method) => {
    expect(method in RcpSession.prototype).toBe(false)
    expect(method in CyanViewRcpConnectionManager.prototype).toBe(false)
  })

  it('has no source here or in CyanView RCP that names the record command or the group topic', async () => {
    const files = [
      ...(await sources(path.resolve(here, '../src'))),
      ...(await sources(path.join(root, 'modules/cyanview-rcp/src'))),
    ]
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      for (const term of forbidden) expect(text, file).not.toContain(term)
    }
  })

  // CyanView RCP bundles this session to switch cameras, so its package carries whatever is here.
  it.skipIf(!existsSync(builtModule))('leaves none of it in the built CyanView RCP package', async () => {
    const text = await readFile(builtModule, 'utf8')
    for (const term of forbidden) expect(text, 'Rebuild modules/cyanview-rcp').not.toContain(term)
  })

  it('does not expose the old action executor through the host runtime', async () => {
    const read = async (name: string): Promise<Record<string, string>> =>
      JSON.parse(
        await readFile(path.join(root, 'packages/official-module-runtime', name), 'utf8'),
      ) as Record<string, string>
    expect(await read('entries.json')).not.toHaveProperty(['cyanview-rcp-action-executor'])
    expect(Object.values(await read('host-shims.json'))).not.toContain(
      'cyanview-rcp-action-executor',
    )
  })
})
