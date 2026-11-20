import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { createModuleHarness } from '@hubble/module-sdk/testing';
import type { HubbleModule, ModuleDocumentSnapshot, ModuleJsonValue } from '@hubble/module-sdk';
import { createInstance } from '../src/index.js';
import { documentDefinitions, PlanRepository } from '../src/repository.js';
import type { SocketFactory } from '../src/transport.js';
import { SimulatedController } from '../src/simulated/controller.js';
import { object, type Plan, type RecordValue } from '../src/model.js';
import type { ServiceOptions } from '../src/service.js';
import { RcpSession } from '../src/control/rcp-session.js';
import type { ControlOptions } from '../src/control/service.js';

export const noEquipment: ControlOptions = { session: (definition, changed) => new RcpSession(definition, changed, true, () => createConnection({ host: '127.0.0.1', port: 9 })) };

export function fixture(settings: RecordValue = {}, options: ServiceOptions = {}, shared?: Map<string, ModuleDocumentSnapshot>) {
  const records = shared ?? new Map<string, ModuleDocumentSnapshot>();
  let failWrite: string | undefined;
  let heldPart: string | undefined, writeHold: Promise<void> | undefined;
  let slowRead: { part: string; ms: number } | undefined;
  let refusedWatches = 0;
  // Every document request the module makes of Hubble, in order, so a test can count what a press reads.
  const requests: { method: string; id: string }[] = [];
  let heldRead: string | undefined, readHold: Promise<void> | undefined;
  let failedReads: { part: string; count: number } | undefined;
  let refusedPlanWatches = 0, quietWatch: string | undefined;
  const pendingWatches = new Map<string, unknown>();
  const watchers = new Map<string, Set<() => void>>();
  const definitions = documentDefinitions();
  const scope = { kind: 'host' as const, workspaceId: randomUUID(), capabilityId: 'lightlab-cyanview-config' };
  // Every managed RCP and RIO opens its connections as soon as the worker starts, so no test may default to a real one.
  // Held settings sockets are off unless a test asks for them, since many tests count sockets.
  const module: HubbleModule = { createInstance: context => createInstance(context, { neighbors:async()=>[],control:noEquipment,liveConfig:false,...options }) };
  const harness = createModuleHarness(module, { sampleData: false, ...settings }, { scope,
    requestHost: async (method, raw, signal) => {
      if (method !== 'service') throw new Error('Unexpected host operation');
      const outer = object(raw), input = object(outer.input), id = String(input.id);
      if (outer.service !== 'documents') throw new Error('Unexpected service');
      requests.push({ method: String(input.method), id });
      if (input.method === 'read' && slowRead && id.includes(slowRead.part)) { const { ms } = slowRead; slowRead = undefined; await delay(ms); }
      if (input.method === 'read' && heldRead && id.includes(heldRead)) await readHold;
      if (input.method === 'read' && failedReads && failedReads.count > 0 && id.includes(failedReads.part)) { failedReads.count--; throw new Error('Simulated storage failure'); }
      if (input.method === 'watch' && refusedWatches > 0 && id.includes('camera-control')) { refusedWatches--; throw new Error('Host service is not granted or available for this scope'); }
      if (input.method === 'watch' && refusedPlanWatches > 0 && (id === 'plan' || id === 'sample-plan')) { refusedPlanWatches--; throw new Error('Host service is not granted or available for this scope'); }
      const definition = definitions.find(item => item.id === id); if (!definition) throw new Error('Unknown document');
      let document: ModuleDocumentSnapshot = records.get(id) ?? { workspaceId: scope.workspaceId, owner: { kind: 'host' as const, capabilityId: scope.capabilityId, moduleId: 'lightlab-cyanview-config' }, id, version: 1, revision: null, value: structuredClone(definition.defaultValue) as ModuleDocumentSnapshot['value'], canUndo: false, canRedo: false };
      if (input.method === 'watch' && input.afterRevision === document.revision) {
        pendingWatches.set(id, input.afterRevision);
        await new Promise<void>((resolve, reject) => {
          const entries = watchers.get(id) ?? new Set(); watchers.set(id, entries);
          const done = () => { entries.delete(done); signal?.removeEventListener('abort', abort); resolve(); };
          const abort = () => { entries.delete(done); reject(new Error('Document watch cancelled')); };
          entries.add(done); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }).finally(() => pendingWatches.delete(id));
        document = records.get(id) ?? document;
      }
      if (input.method === 'write') {
        if (heldPart && id.includes(heldPart)) { await writeHold; document = records.get(id) ?? document; }
        if (failWrite && id.includes(failWrite)) { failWrite = undefined; throw new Error('Simulated storage failure'); }
        if (input.expectedRevision !== document.revision) return { status: 'conflict', document } as unknown as ModuleJsonValue;
        document = { ...document, revision: randomUUID(), value: structuredClone(input.value) };
        records.set(id, document);
        if (!(quietWatch && id.includes(quietWatch))) for (const done of [...(watchers.get(id) ?? [])]) done();
      }
      return { status: 'document', document } as unknown as ModuleJsonValue;
    },
  });
  const repository = new PlanRepository(harness.context.services!, settings.sampleData === true);
  const signal = new AbortController().signal;
  return { ...harness, records, repository, signal,
    failNextWrite(part: string) { failWrite = part; },
    slowNextRead(part: string, ms: number) { slowRead = { part, ms }; },
    refuseSelectionWatches(count: number) { refusedWatches = count; },
    requests,
    /** The saved plan's documents read since request number `from`: its main document and its camera and network rows. */
    planReads(from = 0) {
      const root = repository.root;
      return requests.slice(from).filter(request => request.method === 'read' && (request.id === root || request.id.startsWith(root + '-c') || request.id.startsWith(root + '-l'))).map(request => request.id);
    },
    /** True once the module is waiting for the next change to this document after `revision`, so it has taken in that revision. */
    watchingAfter(id: string, revision: string | null) { return pendingWatches.has(id) && pendingWatches.get(id) === revision; },
    refusePlanWatches(count: number) { refusedPlanWatches = count; },
    /** Saves to documents whose id includes `part` reach no watcher, as if a watch had gone quiet without failing. */
    quietWatches(part: string | undefined) { quietWatch = part; },
    failNextReads(part: string, count: number) { failedReads = { part, count }; },
    failedReadsLeft() { return failedReads?.count ?? 0; },
    holdReads(part: string) {
      heldRead = part;
      let release!: () => void;
      readHold = new Promise<void>(resolve => { release = resolve; });
      return () => { heldRead = undefined; release(); };
    },
    holdWrites(part: string) {
      heldPart = part;
      let release!: () => void;
      writeHold = new Promise<void>(resolve => { release = resolve; });
      return () => { heldPart = undefined; release(); };
    },
    call(command: string, value: unknown = null) { return harness.instance.call!('page.studio', { sectionId: 'frontend', commandId: command, value: value as ModuleJsonValue }, harness.execution()) as Promise<any>; },
  };
}

/**
 * A simulated controller reached over a real WebSocket on a loopback port, as tests have always used it. The
 * controller itself is the one Simulated runs in the worker, which reaches it in memory instead.
 */
export class FakeController extends SimulatedController {
  server: Server = createServer();
  wss = new WebSocketServer({ noServer: true });
  port = 0;
  constructor() {
    super();
    this.server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url!, 'http://localhost'), address = url.searchParams.get('device');
      if (!this.answers(address)) { socket.destroy(); return; }
      this.wss.handleUpgrade(request, socket, head, ws => this.accept(ws, url.pathname, address, String(request.headers.origin)));
    });
  }
  async start() { await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve)); this.port = (this.server.address() as { port: number }).port; }
  override socket: SocketFactory = (url, options) => { const parsed = new URL(url); return new WebSocket(`ws://127.0.0.1:${this.port}${parsed.pathname}?device=${parsed.hostname}`, options); };
  override async close() { await super.close(); await new Promise<void>(resolve => this.wss.close(() => resolve())); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
export { SimulatedRemiFleet as FakeRemiFleet } from '../src/simulated/controller.js';

export function planFor(controller: SimulatedController): Plan { const snapshot = controller.snapshot(); return { formatVersion: 1, devices: [snapshot.device], cameras: [], lans: snapshot.lans, uiState: null }; }
