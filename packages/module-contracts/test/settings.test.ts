import { describe, expect, it } from 'vitest'
import { DitBrowseConnectionManager } from '../../../modules/dit-browse/src/dit-browse-connection-manager.js'
import { connectionCandidates } from '../src/settings.js'

describe('module settings boundary', () => {
  it('ignores foreign inventory records and validates its own settings', () => {
    const manager = new DitBrowseConnectionManager(() => {
      throw new Error('disabled connection must not start')
    })
    const connection = {
      connectionId: '00000000-0000-4000-8000-000000000001',
      type: 'dit-browse',
      name: 'test',
      enabled: false,
      port: 7502,
      requestTimeoutMs: 1000,
      schemaVersion: 1,
    }
    expect(() =>
      manager.reconcile([
        null,
        {},
        'future host entry',
        { type: 'unrelated', invalid: 1 },
        connection,
      ]),
    ).not.toThrow()
    expect(() => manager.reconcile([{ ...connection, port: -1 }])).toThrow()
    manager.stop()
  })
  it('ignores values that do not name this module', () => {
    expect(connectionCandidates([null, undefined, 1, 'a', {}, { type: 'a' }], 'a')).toEqual([
      { type: 'a' },
    ])
  })
})
