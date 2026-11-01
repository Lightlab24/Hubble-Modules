import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ModuleChoice, ModuleChoicePage, ModuleChoiceQuery } from '@hubble/module-sdk'

/** Stable pagination for module-owned catalogues. Never cache by a host UI session. */
export function choicePage(
  query: ModuleChoiceQuery,
  choices: readonly ModuleChoice[],
): ModuleChoicePage {
  const all = choices.filter((choice) =>
    `${choice.id} ${choice.label}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()),
  )
  const revision = createHash('sha256').update(JSON.stringify(all)).digest('hex')
  if (query.catalogRevision && query.catalogRevision !== revision)
    throw new Error('Choices changed; search again')
  const offset =
    query.cursor === null ? 0 : z.coerce.number().int().min(0).max(all.length).parse(query.cursor)
  return {
    revision,
    choices: all.slice(offset, offset + query.limit),
    nextCursor: offset + query.limit < all.length ? String(offset + query.limit) : null,
  }
}
