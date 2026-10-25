import { describe, expect, it } from 'vitest'

import {
  DIT_BROWSE_CAPABILITIES,
  DIT_BROWSE_REQUIRED_CAPABILITIES,
  createDitBrowseCommandMessage,
  createFocusCameraCommand,
  parseDitBrowseServerMessage,
} from '../src/protocol.js'

describe('DIT Browse protocol', () => {
  it('accepts legacy capabilities and optional workspace status from the new API', () => {
    expect(
      parseDitBrowseServerMessage({
        type: 'hello',
        protocol: 'ditbrowse.control',
        protocolVersion: 1,
        server: { name: 'DIT Browse', version: '1.0' },
        capabilities: DIT_BROWSE_REQUIRED_CAPABILITIES,
      }).type,
    ).toBe('hello')
    const original = statusEvent({})
    const message = {
      ...original,
      status: {
        ...original.status,
        activeWorkspaceNumber: 2,
        workspaceNumbers: [1, 2],
        visibleTileIds: ['tile-3'],
        tabs: original.status.tabs.map((tab) => ({ ...tab, workspaceNumbers: [1, 2] })),
      },
    }
    expect(parseDitBrowseServerMessage(message)).toEqual(message)
    expect(() =>
      parseDitBrowseServerMessage({
        ...message,
        status: { ...message.status, activeWorkspaceNumber: 0 },
      }),
    ).toThrow()
    expect(
      createDitBrowseCommandMessage('workspace-2', {
        type: 'switchWorkspace',
        workspaceNumber: 2,
      }).command,
    ).toEqual({ type: 'switchWorkspace', workspaceNumber: 2 })
    for (const workspaceNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        createDitBrowseCommandMessage('bad', { type: 'switchWorkspace', workspaceNumber }),
      ).toThrow()
    }
  })

  it('parses the exact version-one server hello', () => {
    expect(
      parseDitBrowseServerMessage({
        type: 'hello',
        protocol: 'ditbrowse.control',
        protocolVersion: 1,
        server: { name: 'DIT Browse', version: '1.0.1' },
        capabilities: DIT_BROWSE_CAPABILITIES,
      }),
    ).toEqual({
      type: 'hello',
      protocol: 'ditbrowse.control',
      protocolVersion: 1,
      server: { name: 'DIT Browse', version: '1.0.1' },
      capabilities: DIT_BROWSE_CAPABILITIES,
    })
  })

  it('rejects unknown hello fields, protocols, and incomplete capabilities', () => {
    const hello = {
      type: 'hello',
      protocol: 'ditbrowse.control',
      protocolVersion: 1,
      server: { name: 'DIT Browse', version: '1.0.1' },
      capabilities: DIT_BROWSE_CAPABILITIES,
    }

    expect(() => parseDitBrowseServerMessage({ ...hello, extra: true })).toThrow(
      'Invalid DIT Browse server message',
    )
    expect(() =>
      parseDitBrowseServerMessage({ ...hello, protocol: 'ditbrowse.control.v2' }),
    ).toThrow('Invalid DIT Browse server message')
    expect(() =>
      parseDitBrowseServerMessage({ ...hello, capabilities: ['status', 'focusCamera'] }),
    ).toThrow('Invalid DIT Browse server message')
  })

  it("creates only camera commands within Hubble's supported range", () => {
    expect(createFocusCameraCommand('request-1', 4)).toEqual({
      type: 'command',
      requestId: 'request-1',
      command: { type: 'focusCamera', cameraNumber: 4 },
    })

    for (const cameraNumber of [0, -1, 1.5, 1_000_000, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createFocusCameraCommand('request-1', cameraNumber)).toThrow(
        'cameraNumber must be an integer between 1 and 999999',
      )
    }
  })

  it('strictly validates status labels and bounded URLs', () => {
    const message = statusEvent({
      title: 'CAM 3',
      url: 'http://10.0.0.3/',
    })

    expect(parseDitBrowseServerMessage(message).type).toBe('event')
    expect(() => parseDitBrowseServerMessage(statusEvent({ title: 'CAM\n3' }))).toThrow(
      'Invalid DIT Browse server message',
    )
    expect(() =>
      parseDitBrowseServerMessage(statusEvent({ url: `http://${'a'.repeat(4_100)}` })),
    ).toThrow('Invalid DIT Browse server message')
  })

  it('sanitizes and bounds server-provided error text', () => {
    const result = parseDitBrowseServerMessage({
      type: 'result',
      requestId: 'request-1',
      ok: false,
      error: {
        code: 'not_found',
        message: `\u0000No camera\n${'x'.repeat(800)}`,
      },
    })

    expect(result.type).toBe('result')
    if (result.type !== 'result' || result.ok) throw new Error('Expected rejected result')
    expect(result.error.message).not.toMatch(/[\u0000\r\n]/)
    expect(result.error.message).toHaveLength(512)
  })
})

function statusEvent(overrides: { readonly title?: string; readonly url?: string }) {
  return {
    type: 'event',
    event: 'status',
    revision: 1,
    status: {
      expansionEnabled: true,
      focusMode: true,
      selectedCameraNumber: 3,
      selectedTileId: 'tile-3',
      selectedIndex: 1,
      tabs: [
        {
          index: 1,
          tileId: 'tile-3',
          cameraId: 'camera-3',
          cameraNumber: 3,
          title: overrides.title ?? 'CAM 3',
          url: overrides.url ?? 'http://10.0.0.3/',
        },
      ],
    },
  }
}
