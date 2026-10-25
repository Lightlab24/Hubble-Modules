// SDK API 1: each instance owns its state. Nothing executes at import.
export default {
  createInstance(context) {
    let active = context.settings.initialState === true
    let started = false
    function publish() {
      context.publishState({
        phase: 'ready',
        message: null,
        observedAt: new Date().toISOString(),
        values: { active },
      })
      context.publishFeedback({
        id: 'active',
        state: active ? 'active' : 'inactive',
        observedAt: new Date().toISOString(),
      })
    }
    return {
      async start() {
        started = true
        publish()
        context.log({ level: 'info', stage: 'started', message: 'Simulation initialized' })
      },
      async execute(actionId, fields, execution) {
        if (execution.signal.aborted)
          return {
            status: 'failure',
            category: 'cancelled',
            message: 'Action cancelled before execution',
          }
        if (!started)
          return { status: 'failure', category: 'unavailable', message: 'Instance is not running' }
        if (actionId === 'toggle-state') { fields = { active: !active }; actionId = 'set-state' }
        if (actionId !== 'set-state' || typeof fields.active !== 'boolean') {
          return {
            status: 'failure',
            category: 'invalid-config',
            message: 'Unknown action or invalid active field',
          }
        }
        active = fields.active
        publish()
        execution.log({
          level: 'info',
          stage: 'state-changed',
          message: 'Local simulation state changed',
        })
        return {
          status: 'success',
          evidence: { kind: 'local', summary: 'Local simulation state updated' },
        }
      },
      async dispose() {
        if (!started) return
        started = false
        context.publishFeedback({ id: 'active', state: 'unavailable', observedAt: null })
      },
    }
  },
}
