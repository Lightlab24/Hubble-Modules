/** Select a module's records from a mixed host inventory before applying its own schema. */
export function connectionCandidates(values: readonly unknown[], type: string): unknown[] {
  return values.filter(
    (value) =>
      value !== null && typeof value === 'object' && 'type' in value && value.type === type,
  )
}
