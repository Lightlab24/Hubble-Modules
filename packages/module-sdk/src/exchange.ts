export * from './exchange-contracts.js'
import { z } from 'zod'
import { ModuleActionResultSchema, type ModuleJsonValue } from './index.js'
import {
  ModulePeerDescriptionSchema,
  ModulePeerBindingSchema,
  ModuleExchangeRequestSchema,
  ModuleExchangeNotificationSchema,
  type ModuleExchange,
  type ModuleExchangeNotification,
} from './exchange-contracts.js'

/** The host supplies identities, authorization and causal context; none come from module payloads. */
export function createModuleExchange(
  requestHost: (
    method: string,
    value: ModuleJsonValue,
    signal?: AbortSignal,
  ) => Promise<ModuleJsonValue>,
) {
  let sequence = 0
  const listeners = new Map<string, (event: ModuleExchangeNotification) => void | Promise<void>>()
  const request = (value: unknown, signal?: AbortSignal) =>
    requestHost('module-exchange', ModuleExchangeRequestSchema.parse(value), signal)
  const api: ModuleExchange = {
    async discover(signal) {
      return z
        .array(ModulePeerDescriptionSchema)
        .max(1024)
        .parse(await request({ operation: 'discover' }, signal))
    },
    async bindings(signal) {
      return z
        .array(ModulePeerBindingSchema)
        .max(1024)
        .parse(await request({ operation: 'bindings' }, signal))
    },
    query(target, query, signal) {
      return request({ operation: 'query', target, ...query }, signal)
    },
    async publish(id, version, value) {
      await request({ operation: 'publish', id, version, value })
    },
    async reportAction(activity) {
      await request({ operation: 'report-action', activity })
    },
    async execute(target, actionId, fields, signal) {
      return ModuleActionResultSchema.parse(
        await request({ operation: 'execute', target, actionId, fields: { ...fields } }, signal),
      )
    },
    async subscribe(subscription, listener, signal) {
      signal?.throwIfAborted()
      if (listeners.size >= 128) throw new Error('Module subscription capacity reached')
      const subscriptionId = `subscription-${String(++sequence)}`
      listeners.set(subscriptionId, listener)
      const close = async () => {
        signal?.removeEventListener('abort', abort)
        if (listeners.delete(subscriptionId))
          await request({ operation: 'unsubscribe', subscriptionId })
      }
      const abort = () => {
        void close().catch(() => {})
      }
      try {
        await request({ operation: 'subscribe', subscriptionId, subscription }, signal)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) {
          await close()
          signal.throwIfAborted()
        }
      } catch (error) {
        listeners.delete(subscriptionId)
        throw error
      }
      return close
    },
  }
  return {
    api,
    async deliver(subscriptionId: string, event: ModuleExchangeNotification) {
      await listeners.get(subscriptionId)?.(ModuleExchangeNotificationSchema.parse(event))
    },
    dispose() {
      listeners.clear()
    },
  }
}
