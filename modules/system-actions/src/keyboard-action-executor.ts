import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  KeyboardBridgeRequestSchema,
  KeyboardBridgeResponseSchema,
  type KeyboardBridgeProvider,
} from '@hubble/module-contracts/keyboard'
import { connectionCandidates } from '@hubble/module-contracts/settings'
import {
  ConnectionDefinitionsSchema,
  KeyboardModifierSchema,
  parseSystemMenuPath,
  type SystemActionDefinition,
} from './config.js'

export class KeyboardActionExecutor implements TypedActionExecutor<SystemActionDefinition> {
  private readonly enabledConnections: ReadonlySet<string>

  constructor(
    values: readonly unknown[],
    private readonly keyboard?: KeyboardBridgeProvider,
  ) {
    const connections = ConnectionDefinitionsSchema.parse(
      connectionCandidates(values, 'keyboard'),
    )
    this.enabledConnections = new Set(
      connections
        .filter((connection) => connection.type === 'keyboard' && connection.enabled)
        .map((connection) => connection.connectionId),
    )
  }

  async execute(
    action: SystemActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) throw new ActionAbortedError()
    if (
      this.keyboard === undefined ||
      (action.connectionId !== null && !this.enabledConnections.has(action.connectionId))
    ) {
      return {
        outcome: 'failure',
        errorCode: 'keyboard_unavailable',
        errorMessage: 'System actions are unavailable on this Hubble service.',
      }
    }
    try {
      const request = KeyboardBridgeRequestSchema.parse(
        action.type !== 'keyboard.send-shortcut'
          ? {
              operation:
                action.type === 'system.select-menu-item'
                  ? 'select-menu-item'
                  : action.type === 'system.open-application'
                    ? 'open-application'
                    : 'activate-application',
              bundleId: action.applicationBundleId,
              ...(action.type === 'system.select-menu-item'
                ? { menuPath: parseSystemMenuPath(action.menuPath) }
                : {}),
            }
          : {
              operation: 'send-shortcut',
              key: action.key,
              modifiers:
                action.modifiers === ''
                  ? []
                  : action.modifiers
                      .split('+')
                      .map((modifier) => KeyboardModifierSchema.parse(modifier)),
              target:
                action.target === 'global'
                  ? { mode: 'global' }
                  : { mode: 'application', bundleId: action.applicationBundleId },
            },
      )
      const response = KeyboardBridgeResponseSchema.parse(await this.keyboard(request))
      if (
        action.type === 'keyboard.send-shortcut' ? response.sent : response.completed === true
      )
        return { outcome: 'success' }
      return {
        outcome: 'failure',
        errorCode: response.errorCode ?? 'keyboard_event_failed',
        errorMessage: response.message ?? 'The system action could not be completed.',
      }
    } catch (error) {
      if (error instanceof ActionAbortedError) throw error
      return {
        outcome: 'failure',
        errorCode: 'keyboard_unavailable',
        errorMessage:
          'The system action service did not respond. Check Hubble on the service Mac.',
      }
    }
  }
}
