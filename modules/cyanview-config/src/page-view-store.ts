import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Mode = 'real' | 'simulated';
/** A view is a handful of choices, so anything larger is not one. */
const LIMIT = 64 * 1024;

/**
 * Where the page was last left: its tab, sorts, open controllers, filter and the Pending sends panel. It is kept in
 * the module's runtime folder on the computer Hubble runs on, and is not workspace data: it says what one window was
 * looking at, and the page can be open in two windows or on two computers at once, which must not move each other
 * (Nov 25, 2026). Until 0.1.112 it was saved in the shared plan, so every tab click saved the whole plan and pulled
 * every other open copy along. A page reads it only when it opens. Simulated keeps its own. Until Hubble grants the
 * folder it is kept for this run only.
 */
export function pageViewStore(directory: () => string | undefined) {
  const memory: Partial<Record<Mode, unknown>> = {};
  const file = () => { const folder = directory(); return folder ? path.join(folder, 'page-view.json') : null; };
  const readAll = (): Partial<Record<Mode, unknown>> => {
    const target = file();
    if (!target) return memory;
    try { const saved = JSON.parse(readFileSync(target, 'utf8')) as unknown; return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved as Partial<Record<Mode, unknown>> : {}; }
    catch { return {}; }
  };
  return {
    read(mode: Mode): Record<string, unknown> | null {
      const value = readAll()[mode];
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    },
    write(mode: Mode, value: unknown): { saved: true } {
      if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > LIMIT) throw new Error('Invalid page view');
      const target = file();
      if (!target) { memory[mode] = value; return { saved: true }; }
      const all = { ...readAll(), [mode]: value };
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(all), { mode: 0o600 });
      renameSync(temporary, target);
      return { saved: true };
    },
  };
}
