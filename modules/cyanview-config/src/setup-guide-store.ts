import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSetupGuideProgress, type SetupGuideProgress } from './setup-guide-model.js';

type Mode = 'real' | 'simulated';

/**
 * The setup tour's progress on this Mac, in the module's runtime folder: local state that is never
 * part of a workspace export, as HubDash keeps its own Guided setup in the browser. A simulated
 * setup is walked through apart from the real one, so a press on the simulated rig doesn't tick the
 * real guide. Until Hubble grants the folder, progress is kept for this run only.
 */
export function setupGuideStore(directory: () => string | undefined) {
  const memory: Partial<Record<Mode, SetupGuideProgress>> = {};
  const file = () => { const folder = directory(); return folder ? path.join(folder, 'setup-guide.json') : null; };
  const readAll = (): Partial<Record<Mode, unknown>> => {
    const target = file();
    if (!target) return memory;
    try { const saved = JSON.parse(readFileSync(target, 'utf8')) as unknown; return saved && typeof saved === 'object' ? saved as Partial<Record<Mode, unknown>> : {}; }
    catch { return {}; }
  };
  return {
    read(mode: Mode): SetupGuideProgress { return parseSetupGuideProgress(readAll()[mode]); },
    write(mode: Mode, value: unknown): SetupGuideProgress {
      const progress = parseSetupGuideProgress(value);
      const all = { ...readAll(), [mode]: progress };
      const target = file();
      if (!target) { memory[mode] = progress; return progress; }
      mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(all), { mode: 0o600, flush: true });
      renameSync(temporary, target);
      return progress;
    },
  };
}
