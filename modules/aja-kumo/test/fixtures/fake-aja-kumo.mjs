import http from 'node:http'
/** A local implementation of the same /config and login endpoints used by KUMO. */
export class FakeAjaKumo {
  routes = new Map([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ])
  locks = new Set()
  writes = []
  salvoRecalls = []
  salvos = new Map(
    Array.from({ length: 8 }, (_, index) => [
      index + 1,
      {
        name: `Preset ${index + 1}`,
        routes: new Map([
          [1, 4],
          [2, 3],
          [3, 2],
          [4, 1],
        ]),
      },
    ]),
  )
  requests = []
  replies = new Map()
  server
  sessions = new Map()
  waiting = new Map()
  password = ''
  ignoreWrites = false
  rejectWrites = false
  invalidCounts = false
  malformedEvents = false
  holdReads = false
  heldReads = []
  names = new Map()
  port = 0
  constructor() {
    this.server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      this.requests.push(url)
      const json = (value, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (url.pathname === '/authenticator/login') {
        let body = ''
        request.on('data', (chunk) => {
          body += chunk.toString()
        })
        request.on('end', () => {
          if (new URLSearchParams(body).get('password_provided') !== this.password) {
            json({ login: 'failure' })
            return
          }
          response.setHeader('Set-Cookie', ['kumo_session=authenticated; Path=/; HttpOnly'])
          json({ login: 'success' })
        })
        return
      }
      if (this.password !== '' && request.headers.cookie !== 'kumo_session=authenticated') {
        json({}, 401)
        return
      }
      if (url.pathname !== '/config' || url.searchParams.get('configid') !== '0') {
        json({}, 404)
        return
      }
      const action = url.searchParams.get('action')
      const reply = this.replies.get(`${action}:${url.searchParams.get('paramid') ?? ''}`)
      if (reply !== undefined) {
        response.writeHead(reply.status ?? 200, {
          'Content-Type': 'application/json',
          ...reply.headers,
        })
        response.end(reply.body ?? JSON.stringify(reply.value))
        return
      }
      if (action === 'connect') {
        const id = String(this.sessions.size + 1)
        this.sessions.set(id, [])
        json({ connectionid: Number(id) })
      } else if (action === 'wait_for_config_events') {
        const id = url.searchParams.get('connectionid') ?? ''
        if (this.malformedEvents) {
          json({ invalid: true })
          return
        }
        const events = this.sessions.get(id)
        if (events === undefined) {
          json({}, 404)
          return
        }
        if (events.length > 0) {
          json(events.splice(0))
          return
        }
        this.waiting.set(id, response)
        const heartbeat = setTimeout(() => {
          if (this.waiting.get(id) !== response) return
          this.waiting.delete(id)
          json([])
        }, 1_000)
        heartbeat.unref()
        response.on('close', () => {
          clearTimeout(heartbeat)
          if (this.waiting.get(id) === response) this.waiting.delete(id)
        })
      } else if (action === 'get') {
        const param = url.searchParams.get('paramid') ?? ''
        const route = /^eParamID_XPT_Destination(\d+)_Status$/u.exec(param)
        const lock = /^eParamID_XPT_Destination(\d+)_Locked$/u.exec(param)
        const name = /^eParamID_XPT_(Source|Destination)(\d+)_Line_([12])$/u.exec(param)
        const salvo = /^eParamID_Salvo([1-8])$/u.exec(param)
        if (param === 'eParamID_NumberOfSources') json({ value: this.invalidCounts ? 65 : '4' })
        else if (param === 'eParamID_NumberOfDestinations') json({ value: 4 })
        else if (param === 'eParamID_KumoProductID')
          json({ value: 10, value_name: 'KUMO Test Router' })
        else if (salvo !== null) json({ value: { name: this.salvos.get(Number(salvo[1])).name } })
        else if (route !== null) {
          const value = this.routes.get(Number(route[1]))
          if (this.holdReads) this.heldReads.push(() => json({ value }))
          else json({ value })
        } else if (lock !== null) json({ value: this.locks.has(Number(lock[1])) ? 1 : 0 })
        else if (name !== null)
          json({
            value: this.names.get(param) ?? (name[3] === '1' ? `${name[1]} ${name[2]}` : 'Studio'),
          })
        else json({}, 404)
      } else if (action === 'set') {
        if (url.searchParams.get('paramid') === 'eParamID_TakeSalvo') {
          const number = Number(url.searchParams.get('value'))
          const salvo = this.salvos.get(number)
          if (this.rejectWrites || salvo === undefined) {
            json({}, 403)
            return
          }
          this.salvoRecalls.push(number)
          if (!this.ignoreWrites) {
            for (const [destination, source] of salvo.routes) {
              if (!this.locks.has(destination)) this.route(destination, source)
            }
          }
          json({ value: number })
          return
        }
        const destination = Number(
          /^eParamID_XPT_Destination(\d+)_Status$/u.exec(
            url.searchParams.get('paramid') ?? '',
          )?.[1],
        )
        const source = Number(url.searchParams.get('value'))
        if (this.rejectWrites || this.locks.has(destination)) {
          json({}, 403)
          return
        }
        this.writes.push({ destination, source })
        if (!this.ignoreWrites) this.route(destination, source)
        json({ value: source })
      } else json({}, 400)
    })
  }
  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.port = this.server.address().port
  }
  route(destination, source) {
    this.routes.set(destination, source)
    this.emit({ param_id: `eParamID_XPT_Destination${destination}_Status`, int_value: source })
  }
  emit(event) {
    for (const [id, events] of this.sessions) {
      events.push(event)
      const response = this.waiting.get(id)
      if (response !== undefined) {
        this.waiting.delete(id)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(events.splice(0)))
      }
    }
  }
  async stop() {
    this.server.closeAllConnections()
    await new Promise((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    )
  }
}
