import { FakeVideohubServer } from '../src/index.js'

export { FakeVideohubServer, type FakeVideohubServerOptions } from '../src/index.js'

function numericArgument(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const argument = process.argv.find((entry) => entry.startsWith(prefix))
  if (argument === undefined) return fallback
  const value = Number(argument.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new RangeError(`${name} must be an integer from 1 to 65536`)
  }
  return value
}

const fake = await FakeVideohubServer.start({
  listenPort: numericArgument('port', 9_990),
  sourceCount: numericArgument('sources', 40),
  destinationCount: numericArgument('destinations', 40),
})
process.stdout.write(`Fake Blackmagic Videohub listening on 127.0.0.1:${String(fake.port)}\n`)
const close = (): void => {
  void fake.close().finally(() => process.exit(0))
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
