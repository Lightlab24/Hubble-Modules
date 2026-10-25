import {
  ActionAbortedError,
  type ActionExecutionContext,
} from '@hubble/module-contracts/execution'
import {
  type KeyboardBridgeProvider,
  unavailableKeyboardBridgeResponse,
} from '@hubble/module-contracts/keyboard'
import { describe, expect, it, vi } from 'vitest'
import {
  ButtonIdentifierSchema,
  KeyboardConnectionDefinitionSchema,
  KeyboardSendShortcutActionDefinitionSchema,
  SystemActivateApplicationActionSchema,
  SystemOpenApplicationActionSchema,
  SystemSelectMenuItemActionSchema,
} from '../src/config.js'
import { KeyboardActionExecutor } from '../src/keyboard-action-executor.js'

const connection = KeyboardConnectionDefinitionSchema.parse({
  connectionId: '11111111-1111-4111-8111-111111111111',
  type: 'keyboard',
  name: 'Keyboard',
  enabled: true,
  schemaVersion: 1,
})
const action = KeyboardSendShortcutActionDefinitionSchema.parse({
  actionId: 'keyboard-1',
  actionColumnId: '22222222-2222-4222-8222-222222222222',
  connectionId: connection.connectionId,
  interaction: 'press',
  type: 'keyboard.send-shortcut',
  enabled: true,
  target: 'global',
  applicationBundleId: '',
  key: 'KeyK',
  modifiers: 'command+shift',
})
const context = (signal = new AbortController().signal): ActionExecutionContext => ({
  signal,
  executionId: 'execution-1',
  buttonNumber: ButtonIdentifierSchema.parse('1'),
  interaction: 'press',
  wrap: true,
})
const sent = {
  ...unavailableKeyboardBridgeResponse(),
  available: true,
  permissionGranted: true,
  sent: true,
  errorCode: null,
  message: null,
}

describe('KeyboardActionExecutor', () => {
  it('sends a built-in shortcut with no module connection', async () => {
    const provider = vi.fn<KeyboardBridgeProvider>().mockResolvedValue(sent)
    await expect(
      new KeyboardActionExecutor([], provider).execute(
        { ...action, connectionId: null },
        context(),
      ),
    ).resolves.toEqual({ outcome: 'success' })
    expect(provider).toHaveBeenCalledOnce()
  })
  it.each(['open-application', 'activate-application'] as const)(
    'executes %s without keyboard permission or sending keys',
    async (operation) => {
      const schema =
        operation === 'open-application'
          ? SystemOpenApplicationActionSchema
          : SystemActivateApplicationActionSchema
      const appAction = schema.parse({
        actionId: action.actionId,
        actionColumnId: action.actionColumnId,
        interaction: 'press',
        enabled: true,
        type: `system.${operation}`,
        connectionId: null,
        applicationBundleId: 'com.apple.TextEdit',
      })
      const provider = vi
        .fn<KeyboardBridgeProvider>()
        .mockResolvedValue({ ...sent, sent: false, completed: true, permissionGranted: false })
      await expect(
        new KeyboardActionExecutor([], provider).execute(appAction, context()),
      ).resolves.toEqual({ outcome: 'success' })
      expect(provider).toHaveBeenCalledExactlyOnceWith({
        operation,
        bundleId: 'com.apple.TextEdit',
      })
      provider.mockResolvedValue({ ...sent, sent: true, completed: false })
      await expect(
        new KeyboardActionExecutor([], provider).execute(appAction, context()),
      ).resolves.toMatchObject({ outcome: 'failure' })
    },
  )

  it.each(['global', 'application'] as const)(
    'sends the exact %s target and modifiers',
    async (target) => {
      const provider = vi.fn<KeyboardBridgeProvider>().mockResolvedValue(sent)
      const executor = new KeyboardActionExecutor([connection], provider)
      await expect(
        executor.execute(
          { ...action, target, applicationBundleId: 'com.example.Editor' },
          context(),
        ),
      ).resolves.toEqual({ outcome: 'success' })
      expect(provider).toHaveBeenCalledExactlyOnceWith({
        operation: 'send-shortcut',
        key: 'KeyK',
        modifiers: ['command', 'shift'],
        target:
          target === 'global'
            ? { mode: 'global' }
            : { mode: 'application', bundleId: 'com.example.Editor' },
      })
    },
  )
  it('sends an unmodified key without adding modifiers', async () => {
    const provider = vi.fn<KeyboardBridgeProvider>().mockResolvedValue(sent)
    await new KeyboardActionExecutor([connection], provider).execute(
      { ...action, modifiers: '' },
      context(),
    )
    expect(provider.mock.calls[0]?.[0]).toMatchObject({ modifiers: [] })
  })
  it.each([
    'keyboard_permission_required',
    'keyboard_application_not_running',
    'keyboard_event_failed',
  ] as const)('surfaces %s without retry or global fallback', async (errorCode) => {
    const provider = vi
      .fn<KeyboardBridgeProvider>()
      .mockResolvedValue({ ...sent, sent: false, errorCode, message: 'Cannot send shortcut' })
    await expect(
      new KeyboardActionExecutor([connection], provider).execute(action, context()),
    ).resolves.toEqual({ outcome: 'failure', errorCode, errorMessage: 'Cannot send shortcut' })
    expect(provider).toHaveBeenCalledOnce()
  })
  it.each([{ connections: [] }, { connections: [{ ...connection, enabled: false }] }])(
    'does not send for an unavailable connection',
    async ({ connections }) => {
      const provider = vi.fn<KeyboardBridgeProvider>().mockResolvedValue(sent)
      await expect(
        new KeyboardActionExecutor(connections, provider).execute(action, context()),
      ).resolves.toMatchObject({ outcome: 'failure', errorCode: 'keyboard_unavailable' })
      expect(provider).not.toHaveBeenCalled()
    },
  )
  it('does not send after cancellation', async () => {
    const provider = vi.fn<KeyboardBridgeProvider>().mockResolvedValue(sent)
    const abort = new AbortController()
    abort.abort()
    await expect(
      new KeyboardActionExecutor([connection], provider).execute(action, context(abort.signal)),
    ).rejects.toBeInstanceOf(ActionAbortedError)
    expect(provider).not.toHaveBeenCalled()
  })
  it('handles missing providers, transport failures, and malformed responses safely', async () => {
    for (const provider of [
      undefined,
      vi.fn<KeyboardBridgeProvider>().mockRejectedValue(new Error('private details')),
      vi.fn<KeyboardBridgeProvider>().mockResolvedValue({ sent: true } as never),
    ]) {
      await expect(
        new KeyboardActionExecutor([connection], provider).execute(action, context()),
      ).resolves.toMatchObject({ outcome: 'failure', errorCode: 'keyboard_unavailable' })
    }
  })
})

it('sends a structured menu path exactly once and surfaces disabled commands without fallback', async () => {
  const path = [{ title: 'File' }, { title: 'Export', identifier: 'export' }]
  const menu = SystemSelectMenuItemActionSchema.parse({
    actionId: action.actionId,
    actionColumnId: action.actionColumnId,
    interaction: 'press',
    enabled: true,
    type: 'system.select-menu-item',
    connectionId: null,
    applicationBundleId: 'com.example.Editor',
    menuPath: JSON.stringify(path),
  })
  const provider = vi
    .fn<KeyboardBridgeProvider>()
    .mockResolvedValue({ ...sent, sent: false, completed: true })
  await expect(
    new KeyboardActionExecutor([], provider).execute(menu, context()),
  ).resolves.toEqual({
    outcome: 'success',
  })
  expect(provider).toHaveBeenCalledExactlyOnceWith({
    operation: 'select-menu-item',
    bundleId: 'com.example.Editor',
    menuPath: path,
  })
  provider.mockClear().mockResolvedValue({
    ...sent,
    sent: false,
    completed: false,
    errorCode: 'system_menu_disabled',
    message: 'Export is disabled.',
  })
  await expect(
    new KeyboardActionExecutor([], provider).execute(menu, context()),
  ).resolves.toEqual({
    outcome: 'failure',
    errorCode: 'system_menu_disabled',
    errorMessage: 'Export is disabled.',
  })
  expect(provider).toHaveBeenCalledOnce()
})
