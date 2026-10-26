import { describe, expect, it } from 'vitest'
import manifest from '../src/manifest.js'
import { actionSchemas } from '../src/actions.js'

describe('module-owned action registry', () => {
  it('supplies exactly the action IDs advertised to Hubble', () => {
    expect(Object.keys(actionSchemas).sort()).toEqual(
      manifest.actions.map((action) => action.id).sort(),
    )
  })
  it('each validator requires its own stable action ID', () => {
    for (const [id, schema] of Object.entries(actionSchemas)) {
      const result = schema.safeParse({ type: 'unrelated.module-action' })
      expect(result.success, id).toBe(false)
      if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === 'type'), id).toBe(true)
    }
  })
})
