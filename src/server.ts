/**
 * MCP server factory.
 *
 * Exposes memory tools to MCP clients (Claude Desktop, Cursor, Windsurf, VS
 * Code, Zed): search, add, get, update, delete, and list — plus the
 * personal-memory tools (daily brief, timeline, people, reminders, meetings,
 * merge) defined in personal-tools.ts.
 *
 * Transport-agnostic — wire to stdio (cli.ts) or HTTP/SSE (http.ts).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { MnemoApiClient, type ApiClientConfig, MnemoApiError } from './api-client.js'
import { PROCEDURE_TOOLS, dispatchProcedureTool, formatProcedureApiError, isProcedureTool } from './procedure-tools.js'
import {
  PERSONAL_TOOLS,
  PERSONAL_TOOL_INFO,
  dispatchPersonalTool,
  formatPersonalApiError,
  isPersonalTool,
} from './personal-tools.js'

/** Advertised in the MCP initialize handshake; pinned to package.json by server.test.ts. */
export const SERVER_VERSION = '0.4.0'

/**
 * Who authenticated this session. Hosted OAuth grants are rejected by the API
 * on every cross-container personal-memory route, so those tools are not
 * listed to `oauth` sessions at all (calling one anyway yields a clear 403).
 */
export type ServerPrincipal = 'api_key' | 'oauth'

export type ServerOptions = {
  principal?: ServerPrincipal
}

// SECURITY: tool inputs expose content/query knobs plus an OPTIONAL `container`
// tag for the hosted multi-container model. The container is NOT a free tenant
// boundary — the API validates it against the connection's allowed set (403 if
// out of scope). When omitted, the server-configured default/allowed containers
// apply. The model can only target containers the connection already permits.
const CONTAINER_DESCRIPTION =
  "Target memory container tag. Omit to use the connection's default/allowed containers."
const containerField = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(CONTAINER_DESCRIPTION)

const SearchInput = z.object({
  query: z.string().min(1).max(2000).describe('Natural-language search query.'),
  limit: z.number().int().min(1).max(50).default(8).describe('Max number of memories to return.'),
  container: containerField,
  polarity: z
    .enum(['positive', 'negative', 'neutral'])
    .optional()
    .describe(
      'Restrict results to one polarity, with coverage: matching-polarity memories in scope are included even when the query never mentions them. Use "negative" to pull the standing hard constraints (things that must not be done) before acting on a plan or proposal.',
    ),
  searchMode: z
    .enum(['hybrid', 'memories', 'documents'])
    .optional()
    .describe('What to search: extracted memories, raw documents, or both (default hybrid).'),
  excludeIds: z
    .array(z.string().min(1).max(256))
    .max(200)
    .optional()
    .describe('Memory ids to omit — e.g. results already shown, when paginating or deduplicating.'),
  mode: z
    .enum(['fast', 'precise'])
    .optional()
    .describe(
      'Retrieval pipeline: "fast" (default) or "precise" (slower, better ranking). (Values differ from memory_answer\'s mode.)',
    ),
})

// Cap metadata size so a malicious or buggy client cannot push a 10MB blob
// through the MCP boundary (the upstream API enforces its own limits, but
// we'd rather reject early than waste a round-trip).
const METADATA_MAX_SERIALIZED_BYTES = 16 * 1024
const boundedMetadata = z
  .record(z.unknown())
  .refine(
    (m) => {
      try {
        return Buffer.byteLength(JSON.stringify(m), 'utf8') <= METADATA_MAX_SERIALIZED_BYTES
      } catch {
        return false
      }
    },
    { message: `metadata exceeds ${METADATA_MAX_SERIALIZED_BYTES} bytes when serialized` },
  )

// Writer-declared polarity beats the server's phrasing classifier — policy
// register ("No integrations before FY27") reads neutral to a heuristic.
const POLARITY_WRITE_DESCRIPTION =
  'Declare this memory\'s polarity explicitly. Use "negative" for hard constraints and prohibitions so polarity-filtered searches surface them; omit to let the server classify from phrasing.'
const polarityField = z
  .enum(['positive', 'negative', 'neutral'])
  .optional()
  .describe(POLARITY_WRITE_DESCRIPTION)

const AddInput = z.object({
  content: z.string().min(1).max(10_000).describe('The fact or memory to store.'),
  memoryType: z.string().min(1).max(100).optional(),
  polarity: polarityField,
  metadata: boundedMetadata
    .optional()
    .describe('Arbitrary JSON metadata (tags, source, etc.). Max 16KB serialized.'),
  source: boundedMetadata.optional().describe('Provenance for this memory.'),
  idempotencyKey: z.string().min(1).max(200).optional(),
  container: containerField,
})

const UpdateInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID returned by memory_add or memory_search.'),
  content: z.string().min(1).max(10_000).optional(),
  memoryType: z.string().min(1).max(100).optional(),
  polarity: polarityField,
  metadata: boundedMetadata.optional(),
  source: boundedMetadata.nullable().optional(),
  container: containerField,
})

const AnswerInput = z.object({
  question: z.string().min(1).max(2000).describe('Natural-language question to answer from memory.'),
  limit: z.number().int().min(1).max(50).optional().describe('Max snippets retrieved for synthesis.'),
  mode: z
    .enum(['fast', 'full'])
    .optional()
    .describe(
      '"fast" = light reader (~1-2s). "full" (default) = deep synthesis pipeline. (Values differ from memory_search\'s mode.)',
    ),
  includeCitations: z
    .boolean()
    .optional()
    .describe('Return the supporting snippets and scores alongside the answer (default true).'),
  referenceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .optional()
    .describe('ISO date treated as "today" for temporal reasoning.'),
  container: containerField,
})

const DocumentAddInput = z.object({
  // Character cap mirroring the API DTO's @MaxLength(500_000); both count
  // code units, not bytes, so say "characters" rather than overclaim "KB".
  content: z.string().min(1).max(500_000).describe('Raw document text. Hard cap 500,000 characters.'),
  contentType: z
    .string()
    .min(1)
    .max(100)
    .describe('What the document is: "conversation", "note", "email", "webpage", ...'),
  customId: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Stable external id — re-ingesting the same customId updates instead of duplicating.'),
  metadata: boundedMetadata.optional(),
  container: containerField,
})

const JobStatusInput = z.object({
  jobId: z.string().min(1).max(256).describe('Ingestion job id returned by document_add.'),
})

const RestoreInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID to restore (from a prior memory_delete).'),
})

const GetInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID returned by memory_add or memory_search.'),
  container: containerField,
})

const DeleteInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID to delete.'),
  container: containerField,
})

const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1024).optional(),
  container: containerField,
})

const MEMORY_TOOLS: Tool[] = [
  {
    name: 'memory_search',
    description:
      'Search the Mnemo memory store for facts relevant to a query. Returns ranked results (the `results` array) with content, score, and source citations. Use this BEFORE answering any question that might require remembered context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
        polarity: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description:
            'Restrict results to one polarity, with coverage: matching-polarity memories in scope are included even when the query never mentions them. Use "negative" to pull the standing hard constraints (things that must not be done) before acting on a plan or proposal.',
        },
        searchMode: {
          type: 'string',
          enum: ['hybrid', 'memories', 'documents'],
          description: 'What to search: extracted memories, raw documents, or both (default hybrid).',
        },
        excludeIds: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 200,
          description: 'Memory ids to omit — results already shown, when paginating or deduplicating.',
        },
        mode: {
          type: 'string',
          enum: ['fast', 'precise'],
          description:
            'Retrieval pipeline: "fast" (default) or "precise" (slower, better ranking). Values differ from memory_answer\'s mode.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_answer',
    description:
      'Ask a natural-language question and get a synthesized answer WITH citations from the memory store — the cited-answer pipeline, not raw chunks. Use memory_search when you want raw facts to reason over yourself; use memory_answer when you want the reading done for you. mode "fast" answers in ~1-2s; default "full" runs the deep pipeline.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Natural-language question to answer from memory.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        mode: {
          type: 'string',
          enum: ['fast', 'full'],
          description: '"fast" ~1-2s; "full" (default) deep pipeline. Values differ from memory_search\'s mode.',
        },
        includeCitations: { type: 'boolean', default: true },
        referenceDate: {
          type: 'string',
          description: 'YYYY-MM-DD treated as "today" for temporal reasoning.',
        },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['question'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Store a new atomic fact in long-term memory. Use this whenever the user reveals durable preferences, facts about themselves, or context that should persist across sessions. Set polarity: "negative" when storing a hard constraint or prohibition.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        metadata: { type: 'object' },
        memoryType: { type: 'string' },
        polarity: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description: POLARITY_WRITE_DESCRIPTION,
        },
        source: { type: 'object' },
        idempotencyKey: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_update',
    description:
      "Update an existing memory's content or metadata. Use when a previously-stored fact is no longer accurate.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        metadata: { type: 'object' },
        memoryType: { type: 'string' },
        polarity: {
          type: 'string',
          enum: ['positive', 'negative', 'neutral'],
          description: POLARITY_WRITE_DESCRIPTION,
        },
        source: { type: 'object', nullable: true },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one memory by ID within the configured tenant container.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_delete',
    description:
      'Delete a memory by ID. Use only when the user explicitly asks to forget something or when a fact is permanently invalid.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_restore',
    description:
      'Restore a soft-deleted memory while its recovery window is open — the undo for memory_delete. Fails with 409 once the window has closed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Memory ID to restore.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description:
      'List memories in the workspace with cursor pagination. Useful for review/debug; prefer memory_search for retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
    },
  },
  {
    name: 'document_add',
    description:
      'Ingest a raw source document (transcript, page, note, email — up to 500,000 characters) into memory. Extraction runs asynchronously: the response includes a jobId (poll it with job_status where available; the job completes on its own either way). Use memory_add instead for a single atomic fact.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Raw document text. Hard cap 500,000 characters.' },
        contentType: {
          type: 'string',
          description: 'What the document is: "conversation", "note", "email", "webpage", ...',
        },
        customId: {
          type: 'string',
          description: 'Stable external id — re-ingesting the same customId updates instead of duplicating.',
        },
        metadata: { type: 'object' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['content', 'contentType'],
    },
  },
  {
    name: 'job_status',
    description:
      'Status of an ingestion job started by document_add: queued | processing | completed | failed (failed includes the error).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id returned by document_add.' },
      },
      required: ['jobId'],
    },
  },
]

/**
 * Bare-id routes with no container field for the API to validate against an
 * OAuth grant's allowed set. memory_restore is denied to hosted-OAuth MCP
 * principals by the API outright; GET /v1/jobs/{id} is workspace-keyed with
 * no container check, so listing job_status to a container-scoped OAuth
 * grant would let it read job records (documentId, status, error) from
 * containers outside the grant. API-key sessions hold workspace-wide
 * authority already, so neither gate loses them anything.
 */
const API_KEY_ONLY_MEMORY_TOOLS = new Set(['memory_restore', 'job_status'])

/** Tools visible to a session: every memory tool, the personal tools its principal may call, and the procedure tools. */
export function toolsForPrincipal(principal: ServerPrincipal): Tool[] {
  const memory =
    principal === 'oauth'
      ? MEMORY_TOOLS.filter((t) => !API_KEY_ONLY_MEMORY_TOOLS.has(t.name))
      : MEMORY_TOOLS
  const personal =
    principal === 'oauth'
      ? PERSONAL_TOOLS.filter((t) => isPersonalTool(t.name) && PERSONAL_TOOL_INFO[t.name].oauth)
      : PERSONAL_TOOLS
  return [...memory, ...personal, ...PROCEDURE_TOOLS]
}

export function createServer(cfg: ApiClientConfig, options: ServerOptions = {}): Server {
  const api = new MnemoApiClient(cfg)
  const principal = options.principal ?? 'api_key'
  const tools = toolsForPrincipal(principal)
  const server = new Server(
    { name: 'getmnemo', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    // tools/list is discovery, not authorization: a client that already knows
    // a gated tool's name can send tools/call directly. Enforce the principal
    // gate on the CALL path — for job_status this filter is the only thing
    // between a container-scoped OAuth grant and workspace-wide job records.
    // The oauth:false personal tools are also refused here for parity: the
    // API already 403s them for MCP tokens, but hidden-yet-dispatchable is
    // the exact gap this gate exists to close.
    const oauthDenied =
      API_KEY_ONLY_MEMORY_TOOLS.has(name) ||
      (isPersonalTool(name) && !PERSONAL_TOOL_INFO[name].oauth)
    if (principal === 'oauth' && oauthDenied) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Tool '${name}' is not available to OAuth sessions — connect with an API key to use it.`,
          },
        ],
      }
    }
    try {
      const result = await dispatch(api, name, args ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      if (err instanceof McpError) throw err
      const message =
        err instanceof MnemoApiError
          ? isPersonalTool(name)
            ? formatPersonalApiError(err, name)
            : isProcedureTool(name)
              ? formatProcedureApiError(err)
              : formatApiError(err, requestedContainer(args))
          : err instanceof z.ZodError
            ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
            : err instanceof Error
              ? err.message
              : 'Unknown error'
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      }
    }
  })

  return server
}

/** Extract the per-call `container` tag from raw tool args, if any. */
function requestedContainer(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'container' in args) {
    const value = (args as { container: unknown }).container
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Turn a Mnemo API error into a clear MCP tool message. Container-scope
 * failures (403 out-of-scope, 400 write-needs-container) get actionable text
 * instead of a raw status dump.
 */
function formatApiError(err: MnemoApiError, container: string | undefined): string {
  if (err.status === 403) {
    return container
      ? `Container '${container}' is not in this connection's allowed set.`
      : "This request is outside this connection's allowed container set."
  }
  if (err.status === 400 && container === undefined && /container/i.test(err.message)) {
    return 'This connection covers multiple containers — pass `container` to target one (e.g. when adding a memory).'
  }
  return `Mnemo API error (${err.status}): ${err.message}`
}

async function dispatch(
  api: MnemoApiClient,
  name: string,
  raw: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const i = SearchInput.parse(raw)
      return api.search({
        query: i.query,
        limit: i.limit,
        container: i.container,
        polarity: i.polarity,
        searchMode: i.searchMode,
        excludeIds: i.excludeIds,
        mode: i.mode,
      })
    }
    case 'memory_answer': {
      const i = AnswerInput.parse(raw)
      return api.answerQuestion({
        question: i.question,
        limit: i.limit,
        mode: i.mode,
        includeCitations: i.includeCitations,
        referenceDate: i.referenceDate,
        container: i.container,
      })
    }
    case 'memory_add': {
      const i = AddInput.parse(raw)
      return api.addMemory({
        content: i.content,
        memoryType: i.memoryType,
        polarity: i.polarity,
        metadata: i.metadata,
        source: i.source,
        idempotencyKey: i.idempotencyKey,
        container: i.container,
      })
    }
    case 'memory_update': {
      const i = UpdateInput.parse(raw)
      return api.updateMemory(
        i.id,
        {
          content: i.content,
          memoryType: i.memoryType,
          polarity: i.polarity,
          metadata: i.metadata,
          source: i.source,
        },
        i.container,
      )
    }
    case 'memory_restore': {
      const i = RestoreInput.parse(raw)
      return api.restoreMemory(i.id)
    }
    case 'document_add': {
      const i = DocumentAddInput.parse(raw)
      return api.addDocument({
        content: i.content,
        contentType: i.contentType,
        customId: i.customId,
        metadata: i.metadata,
        container: i.container,
      })
    }
    case 'job_status': {
      const i = JobStatusInput.parse(raw)
      return api.getJob(i.jobId)
    }
    case 'memory_get': {
      const i = GetInput.parse(raw)
      return api.getMemory(i.id, i.container)
    }
    case 'memory_delete': {
      const i = DeleteInput.parse(raw)
      return api.deleteMemory(i.id, i.container)
    }
    case 'memory_list': {
      const i = ListInput.parse(raw)
      return api.listMemories({ limit: i.limit, cursor: i.cursor, container: i.container })
    }
    default:
      if (isPersonalTool(name)) return dispatchPersonalTool(api, name, raw)
      if (isProcedureTool(name)) return dispatchProcedureTool(api, name, raw)
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
  }
}
