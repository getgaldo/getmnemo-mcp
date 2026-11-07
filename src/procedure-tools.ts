/**
 * Procedure tools (API /v1/procedures): how the team does things, learned
 * from captured browser work. Read only, and read as a member reads them in
 * the dashboard: published procedures only, no names on sources.
 *
 * All four are open to hosted OAuth sessions and API keys alike. An OAuth
 * connection limited to some containers reaches them only when its grant
 * includes the `procedures:workspace` container; the API answers 403
 * PROCEDURES_OUTSIDE_GRANT otherwise. Scopes: memories:read to list and
 * read and to suggest, search:read to ask (both on MCP connections by default).
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { MnemoApiClient, MnemoApiError } from './api-client.js'

export const PROCEDURE_TOOL_NAMES = ['procedure_list', 'procedure_get', 'procedure_ask', 'procedure_suggest'] as const
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

const ProcedureSuggestInput = z.object({
  app: z
    .string()
    .regex(/^[a-z0-9.-]{1,253}$/, 'a lower-case host name, e.g. app.hubspot.com')
    .optional()
    .describe("The app (host name); the URL's own app when left out."),
  url: z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s/]+\S*$/i, 'an http(s) URL')
    .describe('The page you are on.'),
  recentLabels: z
    .array(z.string().min(1).max(200).regex(/\S/, 'a label must contain non-whitespace text'))
    .max(20)
    .describe('The visible names of the buttons and fields you last used, oldest first. Never what was typed.'),
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
    description: `Read one published procedure: its version history with what changed, and steps[], its current steps as you follow them. Each step has its text, and where it is done when known: action (click, submit or change), page (route shape, e.g. /tickets/:id/edit), target (the control's role and visible name), field (what a change step sets, never the value), and branches ("if X, then Y" after that step). Those fields are null where the procedure does not know. Requires memories:read. ${GRANT_NOTE}`,
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
  {
    name: 'procedure_suggest',
    description: `Which published procedure you are in, from the page you are on and the buttons and fields you last used: at is the step you just did, next the one to do now (null when at was the last), both shaped as procedure_get's steps[]. Rules only, no model. abstained=true (with a reason: no_procedures, too_few_matches, ambiguous) means it cannot tell: do not guess. Requires memories:read. ${GRANT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', pattern: '^[a-z0-9.-]{1,253}$', description: "The app as a lower-case host name; the URL's own app when left out." },
        url: {
          type: 'string',
          maxLength: 2048,
          pattern: '^https?://[^\\s/]+\\S*$',
          description: 'The page you are on (http or https). Its query and fragment are dropped before sending; only its host and path shape are used.',
        },
        recentLabels: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
          description: 'The visible names of the buttons and fields you last used, oldest first. Never what was typed.',
        },
      },
      required: ['url', 'recentLabels'],
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
    case 'procedure_suggest': {
      const input = ProcedureSuggestInput.parse(raw)
      // Never send a query or fragment (tokens, ids): the API reads only the host and path.
      return api.suggestProcedure({ ...input, url: input.url.split(/[?#]/, 1)[0] ?? input.url })
    }
  }
}

/**
 * The API's own message for a refusal: it names the procedures container,
 * which the generic container text would not. Only procedure_get's 404 means
 * "no such procedure"; on the others it is an API without the routes.
 */
export function formatProcedureApiError(err: MnemoApiError, name: ProcedureToolName): string {
  if (err.status === 404 && name === 'procedure_get') return 'No published procedure with that id.'
  return `Mnemo API error (${err.status}): ${err.message}`
}
