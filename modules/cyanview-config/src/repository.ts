import { createModuleDocumentClient, ModuleDocumentValueSchema, type ModuleHostServices, type ModuleManifest } from '@hubble/module-sdk';
import { emptyPlan, json, object, stripEphemeral, validatePlan, type Plan, type RecordValue } from './model.js';
import type { RemiData } from './remi-model.js';
import { choiceDocumentDefinitions } from './choice-catalogs.js';
import { selectionDocuments } from './control/selection.js';

export const ROOTS = ['plan', 'sample-plan'] as const;
type DocumentDefinition = NonNullable<ModuleManifest['documents']>[number];
export function documentDefinitions() {
  return [...ROOTS.flatMap((root): DocumentDefinition[] => [
    { id: root, label: root === 'plan' ? 'Cyanview configuration' : 'Sample configuration', version: 1, defaultValue: { formatVersion: 1, devices: [], lans: [], uiState: null, cameraBank: 0, cameraCount: 0, lanCount: 0 } },
    { id: root + '-remi', label: 'REMI assignments and recovery', version: 1, defaultValue: { links: [], refreshes: [], creates: [] } },
    ...[0, 1].flatMap(bank => [
      ...Array.from({ length: 4 }, (_, part) => ({ id: `${root}-c${bank}-${part}`, label: 'Camera configuration', version: 1, defaultValue: [] })),
      ...Array.from({ length: 8 }, (_, part) => ({ id: `${root}-l${bank}-${part}`, label: 'Network configuration', version: 1, defaultValue: [] })),
    ]),
  ]), ...choiceDocumentDefinitions(), ...selectionDocuments()];
}
export class PlanRepository {
  private documents: ReturnType<typeof createModuleDocumentClient>;
  private tail: Promise<unknown> = Promise.resolve();
  private receiptRevisions = new Set<string | null>();
  private receiptHead: string | null | undefined;
  private deletedCameras = new Set<string>();
  constructor(services: ModuleHostServices, readonly sample: boolean) { this.documents = createModuleDocumentClient(services); }
  get root() { return this.sample ? 'sample-plan' : 'plan'; }
  cameraWasDeleted(id: string) { return this.deletedCameras.has(id); }
  async readRemi(signal: AbortSignal) {
    const document = await this.documents.read(this.root + '-remi', signal);
    const value = object(document.value);
    if (!Array.isArray(value.links) || !Array.isArray(value.refreshes) || !Array.isArray(value.creates)) throw new Error('REMI recovery information could not be read');
    return { document, data: value as RemiData };
  }
  async writeRemi(current: Awaited<ReturnType<PlanRepository['readRemi']>>, signal: AbortSignal) {
    if (JSON.stringify(current.data).length > 240_000) throw new Error('REMI recovery storage is full');
    current.document = await this.documents.write(current.document, json(current.data), signal);
  }
  async read(signal: AbortSignal): Promise<{ revision: string | null; plan: Plan; fresh: boolean }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = await this.documents.read(this.root, signal), value = object(current.value), bank = Number(value.cameraBank ?? 0);
      const cameras = await Promise.all(Array.from({ length: Math.ceil(Number(value.cameraCount ?? 0) / 128) }, (_, part) => this.documents.read(`${this.root}-c${bank}-${part}`, signal)));
      const lans = await Promise.all(Array.from({ length: Math.ceil(Number(value.lanCount ?? 0) / 128) }, (_, part) => this.documents.read(`${this.root}-l${bank}-${part}`, signal)));
      if ((await this.documents.read(this.root, signal)).revision !== current.revision) continue;
      const plan = validatePlan({ formatVersion: 1, devices: value.devices ?? [], cameras: cameras.flatMap(chunk => chunk.value as unknown as RecordValue[]), lans: lans.flatMap(chunk => chunk.value as unknown as RecordValue[]), uiState: value.uiState ?? null });
      return { revision: current.revision, plan, fresh: current.revision === null };
    }
    throw new Error('Configuration changed while reading; refresh and try again');
  }
  private async writeNow(revision: string | null, input: Plan, signal: AbortSignal, preserveReceipts = false) {
    const before = await this.read(signal);
    if (before.revision !== revision && !(preserveReceipts && before.revision === this.receiptHead && this.receiptRevisions.has(revision))) throw new Error('Configuration changed in another editor. Your draft is retained; refresh before saving.');
    const plan = validatePlan(input);
    // Saves can overlap sends. Only our own receipts may advance a draft's
    // revision; a different editor's draft still causes a conflict.
    if (preserveReceipts) plan.cameras = plan.cameras.filter(row => !this.deletedCameras.has(row.id));
    if (preserveReceipts) for (const collection of ['cameras', 'lans'] as const) for (const row of plan[collection]) {
      const old = before.plan[collection].find(item => item.id === row.id);
      if (old) for (const field of ['elementKey', 'newElementKey', 'needsInitialization', 'createState']) if (old[field] !== undefined) row[field] = old[field];
      if (old?.isNew === false) row.isNew = false;
    }
    const current = await this.documents.read(this.root, signal), value = object(current.value);
    if (current.revision !== before.revision) throw new Error('Configuration changed before saving');
    const bank = Number(value.cameraBank ?? 0) ? 0 : 1;
    for (const [kind, rows] of [['c', plan.cameras], ['l', plan.lans]] as const) for (let start = 0; start < rows.length; start += 128) {
      const chunk = rows.slice(start, start + 128).map(stripEphemeral);
      if (JSON.stringify(chunk).length > 250_000) throw new Error('A group of rows exceeds the storage budget; shorten large field values');
      const stored = await this.documents.read(`${this.root}-${kind}${bank}-${start / 128}`, signal);
      await this.documents.write(stored, json(chunk), signal);
    }
    const devices = plan.devices.map(device => {
      const { modelCatalog, models, lensOptions, snapshot, ...saved } = device;
      return saved;
    });
    const saved = await this.documents.write(current, ModuleDocumentValueSchema.parse(json({ formatVersion: 1, devices, uiState: plan.uiState, cameraBank: bank, cameraCount: plan.cameras.length, lanCount: plan.lans.length })), signal);
    if (preserveReceipts) this.receiptRevisions.clear();
    else {
      if (before.revision !== this.receiptHead) this.receiptRevisions.clear();
      this.receiptRevisions.add(before.revision);
      for (const row of before.plan.cameras) if (!plan.cameras.some(item => item.id === row.id)) this.deletedCameras.add(row.id);
    }
    this.receiptHead = saved.revision;
    return { revision: saved.revision, plan, removedDeviceIds: before.plan.devices.filter(device=>!plan.devices.some(item=>item.id===device.id)).map(device=>String(device.id)) };
  }
  write(revision: string | null, plan: Plan, signal: AbortSignal) {
    const task = this.tail.catch(() => undefined).then(() => this.writeNow(revision, plan, signal, true));
    this.tail = task; return task;
  }
  update(change: (plan: Plan) => Plan | void, signal: AbortSignal) {
    const task = this.tail.catch(() => undefined).then(async () => {
      const current = await this.read(signal);
      return this.writeNow(current.revision, change(current.plan) ?? current.plan, signal);
    });
    this.tail = task; return task;
  }
}
