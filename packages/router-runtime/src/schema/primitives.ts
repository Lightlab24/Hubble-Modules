import { z } from 'zod'

export const ConnectionIdSchema = z.uuid().brand<'ConnectionId'>()
