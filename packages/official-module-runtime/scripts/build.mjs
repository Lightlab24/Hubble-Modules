import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import ts from 'typescript'
import { packageNotices } from '../../module-tools/src/package-notices.mjs'
const project = path.resolve(import.meta.dirname, '..')
const root = path.resolve(project, '../..')
const artifactDirectory = path.join(root, 'artifacts')
const stage = path.join(project, 'dist/package')
await rm(path.dirname(stage), { recursive: true, force: true })
await mkdir(stage, { recursive: true })
await mkdir(artifactDirectory, { recursive: true })
const entries = JSON.parse(await readFile(path.join(project, 'entries.json'), 'utf8'))
const sources = Object.fromEntries(
  ['index', ...Object.keys(entries)].map((key) => [
    key,
    path.join(project, 'src', key + '.ts'),
  ]),
)
const bundled = await build({
  absWorkingDir: root,
  metafile: true,
  entryPoints: sources,
  outdir: path.join(stage, 'runtime'),
  bundle: true,
  splitting: true,
  // Host adapters share upstream constructor/error identity with the host's pinned dependencies.
  external: ['got', 'hpagent', 'ws', 'zod', 'bufferutil', 'utf-8-validate'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outExtension: { '.js': '.mjs' },
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
})
async function files(directory) {
  const result = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (
      item.isDirectory() &&
      item.name !== 'node_modules' &&
      item.name !== 'dist' &&
      item.name !== 'test'
    )
      result.push(...(await files(file)))
    else if (item.isFile() && item.name.endsWith('.ts') && !item.name.endsWith('.d.ts'))
      result.push(file)
  }
  return result
}
await writeFile(
  path.join(stage, 'THIRD-PARTY-NOTICES.txt'),
  await packageNotices(root, Object.keys(bundled.metafile.inputs)),
)
const declarationRoot = path.join(stage, 'types')
const paths = [
  ...(await files(path.join(root, 'modules'))),
  ...(await files(path.join(root, 'packages'))),
]
const program = ts.createProgram(paths, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  skipLibCheck: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  declaration: true,
  emitDeclarationOnly: true,
  rootDir: root,
  outDir: declarationRoot,
  types: ['node'],
})
const errors = ts.getPreEmitDiagnostics(program)
if (errors.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  )
const emitted = program.emit()
if (emitted.diagnostics.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(emitted.diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => '\n',
    }),
  )
const packages = new Map()
for (const name of await readdir(path.join(root, 'packages'))) {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8'),
    )
    packages.set(manifest.name, name)
  } catch {}
}
async function relink(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) await relink(file)
    else if (file.endsWith('.d.ts')) {
      let text = await readFile(file, 'utf8')
      text = text.replace(
        /(['"])(@hubble\/[^'"/]+)(?:\/([^'"]+))?\1/g,
        (original, quote, packageName, subpath) => {
          const name = packages.get(packageName)
          if (!name) return original
          const target = path.join(
            declarationRoot,
            'packages',
            name,
            'src',
            (subpath ?? 'index') + '.js',
          )
          let relative = path.relative(path.dirname(file), target).split(path.sep).join('/')
          if (!relative.startsWith('.')) relative = './' + relative
          return quote + relative + quote
        },
      )
      await writeFile(file, text)
    }
  }
}
await relink(declarationRoot)
const exports = Object.fromEntries(
  ['index', ...Object.keys(entries)].map((key) => [
    key === 'index' ? '.' : './' + key,
    {
      types: './types/packages/official-module-runtime/src/' + key + '.d.ts',
      import: './runtime/' + key + '.mjs',
    },
  ]),
)
const manifest = {
  name: '@hubble/official-module-runtime',
  version: '1.0.0',
  type: 'module',
  private: true,
  exports,
  dependencies: {
    zod: '4.4.3',
    got: '15.1.0',
    hpagent: '1.2.0',
    ws: '8.21.0',
    '@types/ws': '8.18.1',
  },
}
await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(
  path.join(stage, 'README.md'),
  'Generated host compatibility bridge from the public Hubble-Modules source. Do not edit generated runtime or declarations. Official downloadable modules do not depend on this aggregate package.\n',
)
const packed = JSON.parse(
  execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDirectory],
    { cwd: stage, encoding: 'utf8' },
  ),
)[0]
const archive = path.join(artifactDirectory, packed.filename),
  bytes = await readFile(archive)
const pin = {
  package: manifest.name,
  version: manifest.version,
  file: packed.filename,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  integrity: packed.integrity,
  url: `https://github.com/Lightlab24/Hubble-Modules/releases/download/runtime-v${manifest.version}/${packed.filename}`,
}
await writeFile(
  path.join(artifactDirectory, 'official-module-runtime.lock.json'),
  JSON.stringify(pin, null, 2) + '\n',
)
console.log(JSON.stringify(pin, null, 2))
