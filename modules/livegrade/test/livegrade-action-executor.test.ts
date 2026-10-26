import { describe, expect, it, vi } from 'vitest'
import {
  ButtonIdentifierSchema,
  LiveGradeSelectSlotActionDefinitionSchema,
  type LiveGradeSelectSlotActionDefinition,
} from '../src/config.js'

import { LiveGradeActionExecutor } from '../src/livegrade-action-executor.js'
import {
  LiveGradeConnectionError,
  type LiveGradeConnectionManagerContract,
} from '../src/livegrade-connection-manager.js'

const action: LiveGradeSelectSlotActionDefinition =
  LiveGradeSelectSlotActionDefinitionSchema.parse({
    actionId: 'livegrade-slot-c',
    interaction: 'press',
    actionColumnId: '22222222-2222-4222-8222-222222222222',
    type: 'livegrade.select-slot',
    connectionId: '11111111-1111-4111-8111-111111111111',
    enabled: true,
    assignmentMode: 'auto-alphanumeric',
    sequence: 3,
    slotId: 'C',
  })

function manager(
  selectSlot: LiveGradeConnectionManagerContract['selectSlot'] = vi.fn(() =>
    Promise.resolve({ position: 3, menuTitle: 'C' }),
  ),
): LiveGradeConnectionManagerContract {
  return {
    requestAccessibilityPermission: vi.fn(() => Promise.resolve()),
    reconcile: vi.fn(),
    refresh: vi.fn(),
    snapshots: vi.fn(() => []),
    subscribe: vi.fn(() => () => undefined),
    selectSlot,
    stop: vi.fn(),
  }
}

const context = {
  executionId: '33333333-3333-4333-8333-333333333333',
  buttonNumber: ButtonIdentifierSchema.parse('LiveGrade / C'),
  interaction: 'press' as const,
  wrap: true,
  signal: new AbortController().signal,
}

describe('LiveGradeActionExecutor', () => {
  it('passes the normalized slot number and letter to background control', async () => {
    const selectSlot = vi.fn(() => Promise.resolve({ position: 3, menuTitle: 'C' }))
    const executor = new LiveGradeActionExecutor(manager(selectSlot))

    await expect(executor.execute(action, context)).resolves.toEqual({ outcome: 'success' })
    expect(selectSlot).toHaveBeenCalledWith(action.connectionId, { position: 3, query: 'C' })
  })

  it.each(['6', '7', 'frontier'] as const)(
    'passes the saved %s application to background control',
    async (application) => {
      const selectSlot = vi.fn(() => Promise.resolve({ position: 3, menuTitle: 'C' }))
      const executor = new LiveGradeActionExecutor(manager(selectSlot))
      await expect(executor.execute({ ...action, application }, context)).resolves.toEqual({
        outcome: 'success',
      })
      expect(selectSlot).toHaveBeenCalledWith(action.connectionId, {
        application,
        position: 3,
        query: 'C',
      })
    },
  )

  it.each([
    ['livegrade_not_running', 'livegrade_not_running'],
    ['livegrade_application_ambiguous', 'livegrade_unconfigured'],
    ['accessibility_permission_required', 'livegrade_permission_required'],
    ['livegrade_menu_unavailable', 'livegrade_menu_unavailable'],
    ['livegrade_slot_not_found', 'livegrade_slot_unavailable'],
    ['livegrade_focus_violation', 'livegrade_focus_violation'],
    ['livegrade_timeout', 'livegrade_timeout'],
  ] as const)('maps %s to bounded action failure %s', async (managerCode, actionCode) => {
    const selectSlot = vi.fn(() =>
      Promise.reject(new LiveGradeConnectionError(managerCode, 'private helper detail')),
    )
    const executor = new LiveGradeActionExecutor(manager(selectSlot))

    await expect(executor.execute(action, context)).resolves.toMatchObject({
      outcome: 'failure',
      errorCode: actionCode,
    })
  })
})
