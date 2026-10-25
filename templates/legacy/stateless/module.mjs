// Stateless request example: injected transport makes device-free tests possible.
export function createRequestModule(request = fetch) {
  return {
    createInstance(context) {
      let ready = false
      return {
        start() {
          ready = true
          context.publishState({
            phase: 'ready',
            message: null,
            observedAt: new Date().toISOString(),
            values: {},
          })
        },
        async execute(actionId, fields, execution) {
          if (!ready)
            return { status: 'failure', category: 'unavailable', message: 'Instance stopped' }
          if (actionId !== 'get-status')
            return { status: 'failure', category: 'invalid-config', message: 'Unknown action' }
          execution.log({
            level: 'info',
            stage: 'request-started',
            message: 'Submitting status request',
          })
          try {
            const response = await request(new URL('/status', context.settings.baseUrl), {
              signal: execution.signal,
            })
            await response.body?.cancel()
            execution.log({
              level: 'info',
              stage: 'response-observed',
              message: `Observed HTTP ${response.status}`,
            })
            return response.ok
              ? {
                  status: 'success',
                  evidence: {
                    kind: 'response',
                    summary: `HTTP ${response.status} received; device operation was not asserted`,
                  },
                }
              : { status: 'failure', category: 'rejected', message: `HTTP ${response.status}` }
          } catch {
            return {
              status: 'failure',
              category: execution.signal.aborted ? 'cancelled' : 'unavailable',
              message: 'Status request did not complete',
            }
          }
        },
        dispose() {
          ready = false
        },
      }
    },
  }
}
export default createRequestModule()
