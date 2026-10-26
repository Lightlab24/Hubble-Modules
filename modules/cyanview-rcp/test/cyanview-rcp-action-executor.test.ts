import {
  CyanViewRcpConnectionError,
  type CyanViewRcpConnectionManagerContract,
} from '@hubble/protocol-cyanview-rcp'
import { describe, expect, it, vi } from 'vitest'
import {
  ActionDefinitionSchema,
  ButtonIdentifierSchema,
  CyanViewRcpSelectCameraActionDefinitionSchema,
} from '../src/config.js'
import { CyanViewRcpActionExecutor } from '../src/cyanview-rcp-action-executor.js'

const action = CyanViewRcpSelectCameraActionDefinitionSchema.parse({
  actionId: 'camera',
  actionColumnId: '11111111-1111-4111-8111-111111111111',
  connectionId: '22222222-2222-4222-8222-222222222222',
  type: 'cyanview-rcp.select-camera',
  interaction: 'press',
  enabled: true,
  cameraNumber: 102,
})
function fixture(
  selectCamera = vi
    .fn<CyanViewRcpConnectionManagerContract['selectCamera']>()
    .mockResolvedValue(),
) {
  const recordCamera = vi
    .fn<CyanViewRcpConnectionManagerContract['recordCamera']>()
    .mockResolvedValue()
  const recordGroupAll = vi
    .fn<CyanViewRcpConnectionManagerContract['recordGroupAll']>()
    .mockResolvedValue()
  const manager: CyanViewRcpConnectionManagerContract = {
    selectCamera,
    recordCamera,
    recordGroupAll,
    reconcile: () => undefined,
    refresh: () => undefined,
    snapshots: () => [],
    subscribe: () => () => undefined,
    stop: () => undefined,
  }
  const controller = new AbortController()
  return {
    selectCamera,
    recordCamera,
    recordGroupAll,
    executor: new CyanViewRcpActionExecutor(manager),
    controller,
    context: {
      executionId: '33333333-3333-4333-8333-333333333333',
      buttonNumber: ButtonIdentifierSchema.parse('1'),
      interaction: 'press' as const,
      wrap: true,
      signal: controller.signal,
    },
  }
}
describe('CyanView RCP action execution', () => {
  it('sends the selected camera and cancellation signal', async () => {
    const { executor, context, selectCamera } = fixture()
    await expect(executor.execute(action, context)).resolves.toEqual({ outcome: 'success' })
    expect(selectCamera).toHaveBeenCalledExactlyOnceWith(
      action.connectionId,
      102,
      context.signal,
    )
  })
  it('reports a sanitized transport failure and hides unexpected error details', async () => {
    const known = fixture(
      vi
        .fn()
        .mockRejectedValue(new CyanViewRcpConnectionError('cyanview_timeout', 'RCP timed out')),
    )
    await expect(known.executor.execute(action, known.context)).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'cyanview_timeout',
      errorMessage: 'RCP timed out',
    })
    const unknown = fixture(vi.fn().mockRejectedValue(new Error('private transport data')))
    await expect(unknown.executor.execute(action, unknown.context)).resolves.toEqual({
      outcome: 'failure',
      errorCode: 'cyanview_protocol_error',
      errorMessage: 'CyanView RCP command failed',
    })
  })
  it('aborts before sending or when cancellation happens during delivery', async () => {
    const before = fixture()
    before.controller.abort()
    await expect(before.executor.execute(action, before.context)).rejects.toThrow()
    expect(before.selectCamera).not.toHaveBeenCalled()
    const during = fixture()
    during.selectCamera.mockImplementation(() => {
      during.controller.abort()
      return Promise.reject(new Error('cancelled'))
    })
    await expect(during.executor.execute(action, during.context)).rejects.toThrow()
  })
})

describe('CyanView RCP recording execution', () => {
  it.each(['record-camera', 'record-group-all'] as const)(
    'dispatches %s once to the correct transport method',
    async (command) => {
      const { executor, selectCamera, recordCamera, recordGroupAll, context } = fixture()
      const recording = ActionDefinitionSchema.parse({
        actionId: 'record',
        actionColumnId: action.actionColumnId,
        interaction: 'press',
        enabled: true,
        connectionId: action.connectionId,
        type: `cyanview-rcp.${command}`,
        ...(command === 'record-camera' ? { cameraNumber: 104 } : {}),
      })
      if (
        recording.type !== 'cyanview-rcp.record-camera' &&
        recording.type !== 'cyanview-rcp.record-group-all'
      )
        throw new Error('Expected a recording action')
      await expect(executor.execute(recording, context)).resolves.toEqual({
        outcome: 'success',
      })
      expect(selectCamera).not.toHaveBeenCalled()
      if (command === 'record-camera') {
        expect(recordCamera).toHaveBeenCalledExactlyOnceWith(
          action.connectionId,
          104,
          context.signal,
        )
        expect(recordGroupAll).not.toHaveBeenCalled()
      } else {
        expect(recordGroupAll).toHaveBeenCalledExactlyOnceWith(
          action.connectionId,
          context.signal,
        )
        expect(recordCamera).not.toHaveBeenCalled()
      }
    },
  )
})
