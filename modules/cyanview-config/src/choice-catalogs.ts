import { createModuleDocumentClient, ModuleDocumentConflictError, type ModuleHostServices } from '@hubble/module-sdk';
import { cameraChoiceFields, type CameraChoice, type CameraChoiceField } from './choice-context.js';
import { json, object, stable } from './model.js';

type Catalogs = Record<string, CameraChoice[]>;
const documentId = (field: CameraChoiceField) => 'plan-choices-' + field;
const documentBudget = 240_000;

export function choiceDocumentDefinitions() {
  return cameraChoiceFields.map(field => ({
    id: documentId(field), label: 'Saved camera choices · ' + field, version: 1, defaultValue: {},
  }));
}

export class ChoiceCatalogs {
  private documents: ReturnType<typeof createModuleDocumentClient>;
  constructor(services: ModuleHostServices) { this.documents = createModuleDocumentClient(services); }

  async read(signal: AbortSignal): Promise<Catalogs> {
    const snapshots = await Promise.all(cameraChoiceFields.map(field => this.documents.read(documentId(field), signal)));
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
      const snapshot = await this.documents.read(documentId(field), signal);
      const catalogs = new Map(Object.entries(object(snapshot.value)));
      const changed = eligible.filter(([key, entries]) => stable(catalogs.get(key)) !== stable(entries));
      if (!changed.length) return true;
      for (const [key, entries] of changed) {
        catalogs.delete(key);
        catalogs.set(key, entries);
      }
      // Oldest lists age out independently of configuration storage.
      while (JSON.stringify(Object.fromEntries(catalogs)).length > documentBudget && catalogs.size > 1) {
        catalogs.delete(catalogs.keys().next().value!);
      }
      try {
        await this.documents.write(snapshot, json(Object.fromEntries(catalogs)), signal);
        return eligible.every(([key]) => catalogs.has(key));
      } catch (error) {
        if (!(error instanceof ModuleDocumentConflictError) || attempt === 5) throw error;
      }
    }
    return false;
  }
}
