import { createModuleDocumentClient, ModuleDocumentConflictError, type ModuleHostServices } from '@hubble/module-sdk';
import { cameraChoiceFields, type CameraChoice, type CameraChoiceField } from './choice-context.js';
import { json, object, stable } from './model.js';

type Catalogs = Record<string, CameraChoice[]>;
const documentId = (field: CameraChoiceField) => 'plan-choices-' + field;
/**
 * Simulated keeps its own lists, so a simulated controller that shares a real one's serial can't replace that
 * controller's choices. A few simulated controllers' lists fit in one document, by field.
 */
const SIMULATED = 'sample-choices';
const documentBudget = 240_000;

export function choiceDocumentDefinitions() {
  return [...cameraChoiceFields.map(field => ({
    id: documentId(field), label: 'Saved camera choices · ' + field, version: 1, defaultValue: {},
  })), { id: SIMULATED, label: 'Simulated camera choices', version: 1, defaultValue: {} }];
}

export class ChoiceCatalogs {
  private documents: ReturnType<typeof createModuleDocumentClient>;
  constructor(services: ModuleHostServices, private simulated = false) { this.documents = createModuleDocumentClient(services); }
  private document(field: CameraChoiceField) { return this.simulated ? SIMULATED : documentId(field); }
  /** One field's lists as a document holds them. */
  private lists(value: unknown, field: CameraChoiceField) { return this.simulated ? object(object(value)[field]) : object(value); }
  /** A document's value with one field's lists replaced. */
  private holding(value: unknown, field: CameraChoiceField, lists: Catalogs) { return this.simulated ? { ...object(value), [field]: lists } : lists; }

  async read(signal: AbortSignal): Promise<Catalogs> {
    const snapshots = this.simulated
      ? await this.documents.read(SIMULATED, signal).then(snapshot => cameraChoiceFields.map(field => ({ value: this.lists(snapshot.value, field) })))
      : await Promise.all(cameraChoiceFields.map(field => this.documents.read(documentId(field), signal)));
    return Object.fromEntries(snapshots.flatMap(snapshot => Object.entries(object(snapshot.value)).filter(([, entries]) =>
      Array.isArray(entries) && entries.length && entries.every(entry =>
        entry && typeof entry.label === 'string' && (entry.port === null || typeof entry.port === 'string')))));
  }

  save(field: CameraChoiceField, key: string, entries: CameraChoice[], signal: AbortSignal) {
    return this.saveMany(field, [[key, entries]], signal);
  }

  async saveMany(field: CameraChoiceField, lists: [string, CameraChoice[]][], signal: AbortSignal) {
    // An empty or incomplete reply must never erase a usable offline list.
    const eligible = lists.filter(([key, entries]) => entries.length && JSON.stringify({ [key]: entries }).length <= documentBudget);
    if (!eligible.length) return false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const snapshot = await this.documents.read(this.document(field), signal);
      const catalogs = new Map(Object.entries(this.lists(snapshot.value, field)));
      const changed = eligible.filter(([key, entries]) => stable(catalogs.get(key)) !== stable(entries));
      if (!changed.length) return true;
      for (const [key, entries] of changed) {
        catalogs.delete(key);
        catalogs.set(key, entries);
      }
      // Oldest lists age out independently of configuration storage.
      while (JSON.stringify(this.holding(snapshot.value, field, Object.fromEntries(catalogs))).length > documentBudget && catalogs.size > 1) {
        catalogs.delete(catalogs.keys().next().value!);
      }
      try {
        await this.documents.write(snapshot, json(this.holding(snapshot.value, field, Object.fromEntries(catalogs))), signal);
        return eligible.every(([key]) => catalogs.has(key));
      } catch (error) {
        if (!(error instanceof ModuleDocumentConflictError) || attempt === 5) throw error;
      }
    }
    return false;
  }
}
