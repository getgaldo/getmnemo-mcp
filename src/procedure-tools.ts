/**
 * Procedure tools (API /v1/procedures): how the team does things, learned
 * from captured browser work. Read only, and read as a member reads them in
 * the dashboard: published procedures only, no names on sources.
 *
 * All three are open to hosted OAuth sessions and API keys alike. An OAuth
 * connection limited to some containers reaches them only when its grant
 * includes the `procedures:workspace` container; the API answers 403
 * PROCEDURES_OUTSIDE_GRANT otherwise. Scopes: memories:read to list and
 * read, search:read to ask (both on MCP connections by default).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { MnemoApiClient, MnemoApiError } from './api-client.js'

export const PROCEDURE_TOOL_NAMES = ['procedure_list', 'procedure_get', 'procedure_ask'] as const
export type ProcedureToolName = (typeof PROCEDURE_TOOL_NAMES)[number]

export function isProcedureTool(name: string): name is ProcedureToolName {
  return (PROCEDURE_TOOL_NAMES as readonly string[]).includes(name)
}

const GRANT_NOTE =
  'Needs the procedures:workspace container in a container-limited connection.'

const ProcedureListInput = z.object({
  app: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/, 'a lower-case host name, e.g. app.hubspot.com')
    .optional()
    .describe('Only procedures for this app (host name).'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1024).optional(),
})

const ProcedureGetInput = z.object({ id: z.string().uuid().describe('Procedure id from procedure_list.') })

const ProcedureAskInput = z.object({
  q: z
    .string()
    .max(500)
    .regex(/\S/, 'q must contain non-whitespace text')
    .describe('The question, e.g. "how do we process a wholesale return?"'),
})

export const PROCEDURE_TOOLS: Tool[] = [
  {
    name: 'procedure_list',
    description: `List the workspace's published procedures (how the team does a task, learned from their browser work), most recently seen first: title, app, how often and by how many people it was seen, step count and current version. Cursor-paginated. Requires memories:read. ${GRANT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Only procedures for this app (host name).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'procedure_get',
    description: `Read one published procedure: its current steps and conditions ("if X, then Y"), and its version history with what changed. Requires memories:read. ${GRANT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Procedure id from procedure_list.' } },
      required: ['id'],
    },
  },
  {
    name: 'procedure_ask',
    description: `Ask how the team does something here. Answered from published procedures only, with citations; abstained=true means no procedure covers it (do not guess). Requires search:read. ${GRANT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', maxLength: 500, description: 'The question.' } },
      required: ['q'],
    },
  },
]

export async function dispatchProcedureTool(
  api: MnemoApiClient,
  name: ProcedureToolName,
  raw: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'procedure_list':
      return api.listProcedures(ProcedureListInput.parse(raw))
    case 'procedure_get':
      return api.getProcedure(ProcedureGetInput.parse(raw).id)
    case 'procedure_ask':
      return api.askProcedures(ProcedureAskInput.parse(raw).q)
  }
}

/** The API's own message for a refusal: it names the procedures container, which the generic container text would not. */
export function formatProcedureApiError(err: MnemoApiError): string {
  if (err.status === 404) return 'No published procedure with that id.'
  return `Mnemo API error (${err.status}): ${err.message}`
}
