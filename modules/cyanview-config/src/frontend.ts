import { connectModuleFrontend } from '@hubble/module-sdk/frontend';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { icons } from 'lucide-react';
import './approved-ui.css';
import './frame.css';
import './workbook-controls.css';

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
  let tail: Promise<unknown> = Promise.resolve();
  const receipts = new Set<(plan: Record<string, unknown>) => void>();
  async function readPlan() {
    const result = await client.call('read-plan') as { revision: string | null; sample: boolean; plan: Record<string, unknown> | null; token?: string; length?: number };
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
    async read() {
      const result = await readPlan();
      revision = result.revision; bridge.preview = result.sample; return result.plan;
    },
    save(plan: unknown | (() => unknown), saved?: () => void, failed?: (error: unknown) => void) {
      return enqueue(async () => {
        try {
        const resolved = typeof plan === 'function' ? plan() : plan;
        const text = JSON.stringify(resolved);
        let result: { revision: string };
        if (text.length < 180000) result = await client.call('save-plan', payload({ revision, plan: resolved })) as unknown as { revision: string };
        else {
          const transfer = await client.call('save-begin', { revision }) as { id: string };
          for (let offset = 0, index = 0; offset < text.length; offset += 60000, index++) await client.call('save-part', { id: transfer.id, index, text: text.slice(offset, offset + 60000) });
          result = await client.call('save-commit', { id: transfer.id }) as { revision: string };
        }
        revision = result.revision;
        saved?.();
        } catch (error) { failed?.(error); throw error; }
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
      return submitted.then(async ({ reply }) => {
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
      });
    },
    onReceipt(listener: (plan: Record<string, unknown>) => void) { receipts.add(listener); },
    scan(range: string, method = 'ping') { return client.call('scan', { range, method }); },
    stopScan() { return client.call('stop-scan'); },
    probe(address: string) { return client.call('probe', { address }); },
    async findRig(value: unknown) { return readBounded(await client.call('find-rig', payload(value)) as Record<string, any>); },
    async importDevice(device: Record<string, unknown>) {
      const result = await client.call('import-device', payload({ id: device.id, address: device.address || device.base })) as Record<string, any>;
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
      return readBounded(await client.call('remi-send', payload(value)) as Record<string, any>);
    },
    async remiRoute(value: unknown) {
      await tail.catch(() => undefined);
      return readBounded(await client.call('remi-route', payload(value)) as Record<string, any>);
    },
    async refresh(devices?: string[]) {
      return readBounded(await client.call('refresh', devices ? payload({ devices }) : undefined) as Record<string, any>);
    },
    async controlState() { return client.call('camera-control-state'); },
    async controlMutate(value: unknown) {
      await tail.catch(() => undefined);
      return client.call('camera-control-mutate', payload(value));
    },
    subscribe(listener: (value: unknown) => void) { return client.subscribe(state => listener(state && typeof state === 'object' && !Array.isArray(state) ? state.values ?? {} : {})); },
  };
  Reflect.set(globalThis, 'cyanviewModuleBridge', bridge);
  window.addEventListener('pagehide', () => client.dispose(), { once: true });
}
await import('./ui-controller.js');
