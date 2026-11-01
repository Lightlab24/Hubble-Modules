import { randomUUID } from 'node:crypto'
import {
  createModuleHostServices,
  ModuleHostServiceRequests,
  type ModuleJsonValue,
  type ModuleValues,
} from '@hubble/module-sdk'

export function resourceFixture() {
  const requests: unknown[] = []
  let granted = true
  return {
    requests,
    deny() {
      granted = false
    },
    services: createModuleHostServices(async (method, value): Promise<ModuleJsonValue> => {
      if (method !== 'service' || !value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Unexpected fixture host service')
      const request = value as ModuleValues
      if (request.service !== 'resources') throw new Error('Unexpected fixture service')
      const input = ModuleHostServiceRequests.resources.parse(request.input)
      requests.push(input)
      return input.method === 'release'
        ? null
        : granted
          ? { granted: true, leaseId: randomUUID() }
          : { granted: false }
    }),
  }
}
