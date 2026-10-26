import { z } from 'zod'

export const MAX_LIVEGRADE_SLOTS = 4_096

const LETTER_RUN = /\p{L}+/gu

const NUMBER_RUN = /\p{N}+/gu

const WORD_RUN = /[\p{L}\p{N}]+/gu

const SEPARATOR = /[^\p{L}\p{N}]+/gu

const COMBINING_MARK = /\p{M}+/gu

export const LiveGradeGenerationSchema = z.union([z.literal(6), z.literal(7)])

export const LiveGradeEditionSchema = z.enum(['standard', 'frontier'])

export const LiveGradeApplicationEditionSchema = z.enum(['standard', 'frontier', 'pro'])

export type LiveGradeApplicationEdition = z.infer<typeof LiveGradeApplicationEditionSchema>

export const LiveGradeApplicationSchema = z.enum(['6', 'pro6', '7', 'frontier'])

export type LiveGradeApplication = z.infer<typeof LiveGradeApplicationSchema>

export const LIVEGRADE_APPLICATIONS = Object.freeze([
  { value: 'pro6', label: 'LiveGrade Pro 6' },
  { value: '6', label: 'LiveGrade Studio 6' },
  { value: '7', label: 'LiveGrade 7' },
  { value: 'frontier', label: 'LiveGrade Frontier' },
] as const)

export function liveGradeApplicationTarget(application: LiveGradeApplication): {
  readonly generation: 6 | 7
  readonly edition: LiveGradeApplicationEdition
} {
  return {
    generation: application === '6' || application === 'pro6' ? 6 : 7,
    edition:
      application === 'pro6' ? 'pro' : application === 'frontier' ? 'frontier' : 'standard',
  }
}

export function liveGradeActionApplication(
  commandId: string,
  legacyTarget: {
    readonly generation: 6 | 7
    readonly edition?: LiveGradeApplicationEdition | undefined
  },
): LiveGradeApplication {
  const parsed = LiveGradeApplicationSchema.safeParse(commandId.replace(/^select-slot-/u, ''))
  return parsed.success
    ? parsed.data
    : legacyTarget.edition === 'pro'
      ? 'pro6'
      : legacyTarget.edition === 'frontier'
        ? 'frontier'
        : legacyTarget.generation === 6
          ? '6'
          : '7'
}

export const LiveGradeSlotPositionSchema = z.int().min(1).max(MAX_LIVEGRADE_SLOTS)

export const LiveGradeSlotInputSchema = z
  .string()
  .max(256)
  .refine(
    (value) => !/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value),
    'LiveGrade slot text must be one line without control characters',
  )

export const LiveGradeSlotQuerySchema = LiveGradeSlotInputSchema.refine(
  (value) => value.trim().length > 0,
  'LiveGrade slot query must not be blank',
)

export const LiveGradeSlotMenuTitleSchema = LiveGradeSlotQuerySchema

export const LiveGradeSlotCatalogEntrySchema = z
  .strictObject({
    position: LiveGradeSlotPositionSchema,
    menuTitle: LiveGradeSlotMenuTitleSchema,
  })
  .readonly()

export const LiveGradeSlotCatalogSchema = z
  .array(LiveGradeSlotCatalogEntrySchema)
  .max(MAX_LIVEGRADE_SLOTS)
  .superRefine((slots, context) => {
    let previousPosition = 0
    slots.forEach((slot, index) => {
      if (slot.position <= previousPosition) {
        context.addIssue({
          code: 'custom',
          path: [index, 'position'],
          message: 'LiveGrade slots must preserve strictly increasing menu positions',
          input: slot.position,
        })
      }
      previousPosition = slot.position
    })
  })
  .readonly()

export type LiveGradeGeneration = z.infer<typeof LiveGradeGenerationSchema>

export type LiveGradeSlotCatalogEntry = z.infer<typeof LiveGradeSlotCatalogEntrySchema>

export type LiveGradeSlotResolution =
  | Readonly<{ kind: 'resolved'; slot: LiveGradeSlotCatalogEntry }>
  | Readonly<{ kind: 'ambiguous'; candidates: readonly LiveGradeSlotCatalogEntry[] }>
  | Readonly<{ kind: 'unresolved'; candidates: readonly LiveGradeSlotCatalogEntry[] }>

interface ScoredSlot {
  readonly score: number
  readonly slot: LiveGradeSlotCatalogEntry
}

export function normalizeLiveGradeSlotQuery(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARK, '')
    .toLocaleLowerCase('en-US')
    .replace(SEPARATOR, ' ')
    .trim()
}

export function liveGradeSlotAliases(slot: LiveGradeSlotCatalogEntry): readonly string[] {
  const normalized = normalizeLiveGradeSlotQuery(slot.menuTitle)
  const letterRuns = normalized.match(LETTER_RUN) ?? []
  const numberRuns = normalized.match(NUMBER_RUN) ?? []
  const words = normalized.match(WORD_RUN) ?? []
  const aliases = new Set<string>([
    String(slot.position),
    normalized,
    normalized.replaceAll(' ', ''),
    ...letterRuns,
    ...numberRuns,
  ])

  const alphaOnly = normalized.replace(NUMBER_RUN, '').replace(/\s+/gu, ' ').trim()
  if (alphaOnly.length > 0) {
    aliases.add(alphaOnly)
    aliases.add(alphaOnly.replaceAll(' ', ''))
  }
  const numericOnly = numberRuns.join('')
  if (numericOnly.length > 0) aliases.add(numericOnly)

  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 2; end <= words.length; end += 1) {
      aliases.add(words.slice(start, end).join(' '))
    }
  }

  aliases.delete('')
  return Object.freeze([...aliases])
}

export function resolveLiveGradeSlotQuery(
  catalog: readonly LiveGradeSlotCatalogEntry[],
  query: string,
): LiveGradeSlotResolution {
  const parsedCatalog = LiveGradeSlotCatalogSchema.parse(structuredClone(catalog))
  const normalizedQuery = normalizeLiveGradeSlotQuery(query)
  if (normalizedQuery.length === 0) {
    return Object.freeze({ kind: 'unresolved', candidates: parsedCatalog })
  }
  const scored = scoreLiveGradeSlots(parsedCatalog, normalizedQuery).sort(
    (left, right) => left.score - right.score || left.slot.position - right.slot.position,
  )
  const first = scored[0]
  if (first === undefined) {
    return Object.freeze({ kind: 'unresolved', candidates: Object.freeze([]) })
  }
  const candidates = Object.freeze(scored.map(({ slot }) => slot))
  if (first.score > 2) return Object.freeze({ kind: 'unresolved', candidates })
  const best = scored.filter(({ score }) => score === first.score).map(({ slot }) => slot)
  return best.length === 1
    ? Object.freeze({ kind: 'resolved', slot: requiredSlot(best, 0) })
    : Object.freeze({ kind: 'ambiguous', candidates: Object.freeze(best) })
}

function scoreLiveGradeSlots(
  catalog: readonly LiveGradeSlotCatalogEntry[],
  normalizedQuery: string,
): ScoredSlot[] {
  const numericPosition = /^\d+$/u.test(normalizedQuery) ? Number(normalizedQuery) : null
  return catalog.flatMap((slot) => {
    const normalizedTitle = normalizeLiveGradeSlotQuery(slot.menuTitle)
    const aliases = liveGradeSlotAliases(slot)
    const score =
      numericPosition === slot.position
        ? 0
        : normalizedTitle === normalizedQuery
          ? 1
          : aliases.includes(normalizedQuery)
            ? 2
            : aliases.some((alias) => alias.startsWith(normalizedQuery))
              ? 3
              : aliases.some((alias) => alias.includes(normalizedQuery))
                ? 4
                : null
    return score === null ? [] : [{ score, slot }]
  })
}

function requiredSlot(
  slots: readonly LiveGradeSlotCatalogEntry[],
  index: number,
): LiveGradeSlotCatalogEntry {
  const slot = slots[index]
  if (slot === undefined) throw new RangeError(`Missing LiveGrade slot ${String(index)}`)
  return slot
}
