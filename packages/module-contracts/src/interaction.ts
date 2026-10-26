import type { ButtonInteraction } from './types.js'

export type ButtonRotationStep = -1 | 1

/**
 * Press intentionally has no direction. Each adapter must explicitly choose
 * any Press compatibility behavior it needs.
 */
export function rotationStepForInteraction(
  interaction: ButtonInteraction,
): ButtonRotationStep | null {
  switch (interaction) {
    case 'press':
    case 'long-press-1s':
    case 'long-press-2s':
    case 'long-press-3s':
      return null
    case 'rotate-left':
      return -1
    case 'rotate-right':
      return 1
  }
}

/**
 * Applies one rotary step to an ordered list index. Listed indexes either wrap
 * or clamp at the ends according to the physical action policy. A missing or
 * outside index starts at the first item when moving right and the last item
 * when moving left. Callers retain ownership of value validation and lookup,
 * so sparse numbers and other values are never altered.
 */
export function stepOrderedListIndex(
  itemCount: number,
  currentIndex: number | null,
  step: number,
  wrap: boolean,
): number {
  if (!Number.isSafeInteger(itemCount) || itemCount < 1) {
    throw new RangeError('Ordered interaction item count must be a positive safe integer')
  }
  if (step !== -1 && step !== 1) throw new RangeError('Button rotation step must be -1 or 1')

  const currentIsListed =
    currentIndex !== null &&
    Number.isSafeInteger(currentIndex) &&
    currentIndex >= 0 &&
    currentIndex < itemCount
  if (!currentIsListed) return step === 1 ? 0 : itemCount - 1
  const candidate = currentIndex + step
  return wrap
    ? (candidate + itemCount) % itemCount
    : Math.max(0, Math.min(itemCount - 1, candidate))
}

export function isDirectionalButtonInteraction(
  interaction: ButtonInteraction,
): interaction is 'rotate-left' | 'rotate-right' {
  return interaction === 'rotate-left' || interaction === 'rotate-right'
}
