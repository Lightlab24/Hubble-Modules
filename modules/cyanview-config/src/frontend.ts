import { connectModuleFrontend } from '@hubble/module-sdk/frontend';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { icons } from 'lucide-react';
import { isStaleDraft } from './save-conflict.js';
import { mergePlans, planText, type PlanConflict, type PlanValue } from './plan-merge.js';
import './approved-ui.css';
import './frame.css';
import './workbook-controls.css';
import './setup-guide.css';

// The approved UI keeps its original DOM, CSS and rendering functions.
Reflect.set(globalThis, 'lucide', {
  createIcons({ attrs = {} } = {}) {
    document.querySelectorAll<HTMLElement>('i[data-lucide]').forEach(element => {
      const name = String(element.dataset.lucide).split('-').map(part => part[0]?.toUpperCase() + part.slice(1)).join('');
      const component = Reflect.get(icons, name);
      if (!component) return;
      const template = document.createElement('template');
      template.innerHTML = renderToStaticMarkup(React.createElement(component, { ...attrs, className: element.className, 'aria-hidden': true, strokeWidth: 1.7 }));
      element.replaceWith(template.content);
    });
  },
});

if (window.parent !== window) {
  const client = await connectModuleFrontend(window);
  let revision: string | null = null;
  // The saved plan as this copy last read or wrote it, at `revision`. Another copy of the page may save after it.
  let base: PlanValue | null = null, baseText = '';
  const setBase = (plan: PlanValue | null) => { base = plan ? copy(plan) : null; baseText = base ? planText(base) : ''; };
  let tail: Promise<unknown> = Promise.resolve();
  const receipts = new Set<(plan: Record<string, unknown>) => void>();
  const merges = new Set<(from: PlanValue, to: PlanValue, conflicts: PlanConflict[]) => void>();
  // Saves queued or being written, and requests that may change the saved plan while they run. While any is out,
  // the page doesn't read the plan again: what they bring back is applied by the page itself.
  let saving = 0, working = 0;
  const tracked = <T>(request: Promise<T>) => { working++; return request.finally(() => { working--; }); };
  const copy = (value: unknown) => JSON.parse(JSON.stringify(value)) as PlanValue;
  // A save takes the page's plan after the edit is on screen, so the edit isn't held up by it. A hidden window paints
  // nothing, so it waits no more than 50 ms. Whatever is queued behind the save, such as a send, still waits for it.
  const afterPaint = () => new Promise<void>(resolve => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 50);
  });
  async function readPlan() {
    const result = await client.call('read-plan') as { revision: string | null; sample: boolean; simulated?: boolean; plan: Record<string, unknown> | null; token?: string; length?: number };
    if (result.token) {
      let text = '';
      for (let offset = 0; offset < result.length!; offset += 60000) text += (await client.call('read-part', { token: result.token, offset }) as { text: string }).text;
      result.plan = JSON.parse(text);
    }
    return result;
  }
  const payload = (value: unknown): NonNullable<Parameters<typeof client.call>[1]> => JSON.parse(JSON.stringify(value));
  const enqueue = <T>(operation: () => Promise<T>) => {
    const next = tail.catch(() => undefined).then(operation); tail = next; return next;
  };
  async function readBounded(result: Record<string, any>) {
    if (typeof result.token !== 'string') return result;
    let text = '';
    for (let offset = 0; offset < result.length; offset += 60000) {
      text += (await client.call('read-part', { token: result.token, offset }) as { text: string }).text;
    }
    return JSON.parse(text);
  }
  const bridge = {
    preview: false,
    // The module is running against its simulated controllers, which the save status says.
    simulated: false,
    /** The part of the page this window shows, as Hubble's sidebar opened it, or null for the whole page. */
    view: typeof client.view === 'string' ? client.view : null,
    canOpenWindows: client.canOpenWindows === true,
    /** Opens one part of the page in a HubDash window of its own, or brings that window forward. Only on a click. */
    openWindow(view: string, title: string) { return client.openWindow(view, title); },
    async read() {
      const result = await readPlan();
      revision = result.revision; setBase(result.plan);
      bridge.preview = result.sample; bridge.simulated = result.simulated === true; return result.plan;
    },
    /** The saved revision this copy holds, and the plan it read or wrote at it. */
    get revision() { return revision; },
    get base() { return base; },
    /** The page holds what is saved, as far as anyone's work goes. */
    isSaved(plan: PlanValue) { return base !== null && planText(plan) === baseText; },
    /** A save is queued or being written, or a request that may change the saved plan is out. */
    busy() { return saving > 0 || working > 0; },
    /** The saved plan now, without taking it as this copy's. */
    async latest() { const result = await readPlan(); return { revision: result.revision, plan: result.plan }; },
    /** The page has drawn this saved plan, so its next save is made on top of it. */
    accept(plan: PlanValue | null, at: string | null) { revision = at; setBase(plan); },
    /** Told when a save was put onto a plan another copy had saved since: what this copy held, what was saved and what both changed. */
    onMerge(listener: (from: PlanValue, to: PlanValue, conflicts: PlanConflict[]) => void) { merges.add(listener); },
    /**
     * `plan` is the page's whole plan, or a function that makes it, which is called when the save's turn comes, so a
     * save always writes what the page holds then. A plan that is the saved one as far as anyone's work goes isn't
     * written at all: a tab, sort or filter is the page's own and no longer in the plan. `writing` hears when a write
     * starts.
     */
    save(plan: unknown | (() => unknown), saved?: () => void, failed?: (error: unknown) => void, writing?: () => void) {
      saving++;
      return enqueue(async () => {
        try {
        if (typeof plan === 'function') await afterPaint();
        const mine = copy(typeof plan === 'function' ? plan() : plan);
        if (bridge.isSaved(mine)) { saved?.(); return; }
        writing?.();
        const write = async (value: PlanValue, at: string | null): Promise<{ revision: string }> => {
          const text = JSON.stringify(value);
          if (text.length < 180000) return await client.call('save-plan', payload({ revision: at, plan: value })) as unknown as { revision: string };
          const transfer = await client.call('save-begin', { revision: at }) as { id: string };
          for (let offset = 0, index = 0; offset < text.length; offset += 60000, index++) await client.call('save-part', { id: transfer.id, index, text: text.slice(offset, offset + 60000) });
          return await client.call('save-commit', { id: transfer.id }) as { revision: string };
        };
        let result: { revision: string }, written = mine, conflicts: PlanConflict[] = [];
        try { result = await write(mine, revision); }
        catch (error) {
          // Another copy of this page saved after this one read the plan: another HubDash window, or HubDash on another
          // computer. Its whole plan used to go on top, which silently undid what the other copy had saved (Nov 25, 2026).
          // Now what this copy changed since it read goes onto the saved plan, and anything both changed keeps what this
          // copy typed. What controllers reported back (element keys, creates) is kept by the worker.
          if (!isStaleDraft(error)) throw error;
          for (let attempt = 1; ; attempt++) {
            const fresh = await readPlan(), merged = mergePlans(base, mine, fresh.plan);
            try { result = await write(merged.plan, fresh.revision); written = merged.plan; conflicts = merged.conflicts; break; }
            catch (again) { if (!isStaleDraft(again) || attempt >= 4) throw again; }
          }
        }
        revision = result.revision; setBase(written);
        if (written !== mine) for (const listener of merges) listener(mine, written, conflicts);
        saved?.();
        } catch (error) { failed?.(error); throw error; }
        finally { saving--; }
      });
    },
    send(value: unknown) {
      const submitted = enqueue(async () => {
          const text = JSON.stringify(value);
          let reply: Promise<Record<string, unknown>>;
          if (text.length < 180000) reply = client.call('send', payload(value)) as Promise<Record<string, unknown>>;
          else {
            const transfer = await client.call('send-begin') as { id: string };
            for (let offset = 0, index = 0; offset < text.length; offset += 60000, index++) await client.call('send-part', { id: transfer.id, index, text: text.slice(offset, offset + 60000) });
            reply = client.call('send-commit', { id: transfer.id }) as Promise<Record<string, unknown>>;
          }
          // Release the submission queue as soon as the request is dispatched.
          // Per-row ordering lives in the backend, so unrelated auto sends can run.
          return { reply };
      });
      return tracked(submitted.then(async ({ reply }) => {
          let result = await reply;
          if (typeof result.token === 'string') {
            let text = '';
            for (let offset = 0; offset < Number(result.length); offset += 60000) text += (await client.call('read-part', { token: result.token, offset }) as { text: string }).text;
            result = JSON.parse(text);
          }
          // Sends can finish out of order. Only draft saves advance this editor's
          // revision; the repository preserves receipts across concurrent saves.
          return result;
      }).catch(async error => {
          try { const current = await readPlan(); if (current.plan) for (const listener of receipts) listener(current.plan); } catch { /* A disconnected host cannot replace the local draft. */ }
          throw error;
      }));
    },
    onReceipt(listener: (plan: Record<string, unknown>) => void) { receipts.add(listener); },
    scan(range: string, method = 'ping') { return client.call('scan', { range, method }); },
    stopScan() { return client.call('stop-scan'); },
    probe(address: string) { return client.call('probe', { address }); },
    async findRig(value: unknown) { return readBounded(await tracked(client.call('find-rig', payload(value))) as Record<string, any>); },
    async importDevice(device: Record<string, unknown>) {
      const result = await tracked(client.call('import-device', payload({ id: device.id, address: device.address || device.base }))) as Record<string, any>;
      const cameras: unknown[] = [];
      for (let offset = 0; offset < result.cameraCount; offset += 64) {
        const part = await client.call('import-part', { token: String(result.token), offset }) as Record<string, any>;
        cameras.push(...part.cameras);
      }
      return { device: result.device, lans: result.lans, cameras };
    },
    async choiceCatalogs() { return readBounded(await client.call('choice-catalogs') as Record<string, any>); },
    async options(value: unknown) { return readBounded(await client.call('options', payload(value)) as Record<string, any>); },
    async remiState(value: unknown) { return readBounded(await client.call('remi-state', payload(value)) as Record<string, any>); },
    async remiSend(value: unknown) {
      // Wait for previously queued workspace saves, then let the backend order REMI operations.
      await tail.catch(() => undefined);
      return readBounded(await tracked(client.call('remi-send', payload(value))) as Record<string, any>);
    },
    async remiRoute(value: unknown) {
      await tail.catch(() => undefined);
      return readBounded(await tracked(client.call('remi-route', payload(value))) as Record<string, any>);
    },
    /** A live read follows a change a controller just reported, and reads the socket that reported it. */
    async refresh(devices?: string[], live = false) {
      return readBounded(await tracked(client.call('refresh', devices ? payload(live ? { devices, live } : { devices }) : undefined)) as Record<string, any>);
    },
    /** Cyanview's own Enabled on a camera. Its REMI copies follow it. */
    async cameraEnabled(device: string, key: string, enabled: boolean) { return tracked(client.call('camera-enabled', payload({ device, key, enabled }))); },
    /** Switches a camera off and on again, then each REMI copy made from it. */
    async cameraRefresh(device: string, key: string) { return tracked(client.call('camera-refresh', payload({ device, key }))); },
    /** A controller's own web page, opened in the browser on the computer Hubble runs on. */
    async openDevicePage(address: string) { return client.call('open-device-page', payload({ address })); },
    /** Setup mode: an RCP's LAN addresses deleted and its WAN left Static with nothing set. Saves already queued go first. */
    async clearNetwork(device: string, lans: boolean, wan: boolean) {
      await tail.catch(() => undefined);
      return readBounded(await tracked(client.call('clear-network', payload({ device, lans, wan }))) as Record<string, any>);
    },
    async controlState() { return client.call('camera-control-state'); },
    /** Firmware: the file is sent in parts, then checked and installed on the RIOs chosen with it. */
    async firmwareBegin() { return client.call('firmware-begin'); },
    async firmwarePart(value: unknown) { return client.call('firmware-part', payload(value)); },
    async firmwareCommit(value: unknown) { return client.call('firmware-commit', payload(value)); },
    async firmwareTargets(value: unknown) { return client.call('firmware-targets', payload(value)); },
    async firmwareInstall(value: unknown) { return client.call('firmware-install', payload(value)); },
    async firmwareStatus(value: unknown) { return client.call('firmware-status', payload(value)); },
    /** The setup tour's progress on this Mac: null reads it, a value saves it. */
    async setupGuide(progress: unknown) { return client.call('setup-guide', progress === null ? null : payload(progress)); },
    /** Where the page was last left, on the computer Hubble runs on: null reads it, a value saves it. */
    async pageView(view: unknown) { return client.call('page-view', view === null ? null : payload(view)); },
    async controlMutate(value: unknown) {
      await tail.catch(() => undefined);
      return tracked(client.call('camera-control-mutate', payload(value)));
    },
    subscribe(listener: (value: unknown) => void) { return client.subscribe(state => listener(state && typeof state === 'object' && !Array.isArray(state) ? state.values ?? {} : {})); },
  };
  Reflect.set(globalThis, 'cyanviewModuleBridge', bridge);
  window.addEventListener('pagehide', () => client.dispose(), { once: true });
}
await import('./ui-controller.js');
