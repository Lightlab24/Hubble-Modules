import { expect, it } from 'vitest'
import { ModuleManifestSchema } from '../src/index.js'
import { createModulePackage, inspectModulePackage } from '../src/package.js'

const manifest = () => ({
  formatVersion: 1, id: 'example-live-workbook', name: 'Live workbook', version: '1.0.0', apiVersion: 1,
  host: { minimumVersion: '2.0.15', requiredFeatures: ['module-pages-v1', 'module-documents-v1', 'module-table-workbook-v1', 'module-table-live-v1'] },
  configVersion: 1, entry: 'module.mjs', files: ['module.mjs'], capabilities: ['host.documents'],
  actions: [], feedback: [], settings: [],
  documents: [{ id: 'plan', label: 'Plan', version: 1, defaultValue: { rows: [] } }],
  pages: [{ id: 'plan', label: 'Plan', sections: [{ type: 'table', id: 'rows', label: 'Rows',
    source: 'document', documentId: 'plan', maxRows: 10,
    workbook: { stateKey: 'view' },
    live: { source: 'selection', columns: ['enabled'] },
    columns: [{ id: 'enabled', label: 'Enabled', type: 'boolean', required: true, default: false }],
  }] }],
})

it('round-trips package-owned live table declarations and requires their explicit compatibility feature', () => {
  const source = manifest(), parsed = ModuleManifestSchema.parse(source)
  expect(inspectModulePackage(createModulePackage(parsed, new Map([['module.mjs', Buffer.from('export default {}')]]))).manifest).toEqual(parsed)
  source.host.requiredFeatures = ['module-pages-v1', 'module-documents-v1']
  expect(() => ModuleManifestSchema.parse(source)).toThrow('module-table-live-v1')
})

it('restricts live projections to declared editable columns of a document', () => {
  const source = manifest(), table = source.pages[0]!.sections[0]!
  table.live.columns = ['missing']
  expect(() => ModuleManifestSchema.parse(source)).toThrow('editable document columns')
  table.live.columns = ['enabled', 'enabled']
  expect(() => ModuleManifestSchema.parse(source)).toThrow('editable document columns')
  table.live.columns = ['enabled']; table.source = 'state'
  expect(() => ModuleManifestSchema.parse(source)).toThrow('editable document columns')
})
