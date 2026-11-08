export const cameraChoiceFields = ['Model', 'LensModel', 'LensInterface', 'Interface'] as const;
export type CameraChoiceField = typeof cameraChoiceFields[number];
export type CameraChoice = { label: string; port: string | null };
export const isCameraChoiceField = (value: unknown): value is CameraChoiceField =>
  cameraChoiceFields.some(field => field === value);

export function cameraChoiceKey(serial: string, field: CameraChoiceField, elementKey?: string, model?: string, lens?: string) {
  if (field === 'Model') return JSON.stringify([serial, field]);
  if (!elementKey) return null;
  const modelName = String(model ?? '').replace(/^Sony\s*-\s*/i, '').trim().toLowerCase();
  const lensName = field === 'LensInterface' ? String(lens || 'None').trim().toLowerCase() : null;
  return JSON.stringify([serial, field, elementKey, modelName, lensName]);
}
