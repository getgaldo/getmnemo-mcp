/**
 * Personal-memory tools (API v0.3.0): daily brief, container timeline,
 * people, reminders, meetings and memory merge.
 *
 * Every tool here except `memory_timeline` is API-KEY ONLY: the API rejects
 * hosted OAuth MCP tokens on cross-container routes (403), and the required
 * scopes (people:*, reminders:*, brief:read, meetings:read) are opt-in on
 * the key — existing keys must be re-minted or edited to gain them. Each
 * description names the scope(s) and the MEMORY_API_* deployment flag so a
 * 403/503 is self-explanatory to the model.
 *
 * Convention: `container` is listed FIRST in every input schema, before any
 * content-bearing field (content-first ordering has been observed to fold
 * the container into the content field on some clients).
 */

import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { MnemoApiClient, MnemoApiError } from './api-client.js'
import type { CreatePersonInput, PersonRecord, UpdatePersonInput } from './personal-types.js'

const CONTAINER_DESCRIPTION =
  "Target memory container tag. Omit to use the connection's default/allowed containers."
const containerField = z.string().min(1).max(200).optional().describe(CONTAINER_DESCRIPTION)
const isoDateTime = z
  .string()
  .datetime({ offset: true })
  .describe('ISO 8601 date-time, e.g. 2026-09-15T09:00:00Z.')
const ymdDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
const timezoneField = z.string().min(1).max(64).optional().describe('IANA timezone, e.g. America/New_York. Default UTC.')

const METADATA_MAX_SERIALIZED_BYTES = 16 * 1024
const boundedMetadata = z.record(z.string(), z.unknown()).refine(
  (m) => {
    try {
      return Buffer.byteLength(JSON.stringify(m), 'utf8') <= METADATA_MAX_SERIALIZED_BYTES
    } catch {
      return false
    }
  },
  { message: `metadata exceeds ${METADATA_MAX_SERIALIZED_BYTES} bytes when serialized` },
)

export const PERSONAL_TOOL_NAMES = [
  'daily_brief',
  'memory_timeline',
  'people_list',
  'people_get',
  'people_upsert',
  'reminder_create',
  'reminders_upcoming',
  'reminder_complete',
  'meeting_brief',
  'meetings_upcoming',
  'memory_merge',
] as const
export type PersonalToolName = (typeof PERSONAL_TOOL_NAMES)[number]

export type PersonalToolInfo = {
  /** Feature name as the API reports it in `FEATURE_DISABLED` messages. */
  feature: 'brief' | 'timeline' | 'people' | 'meetings' | 'inbox'
  /** Deployment flag the operator must set on the API for this tool to work. */
  envFlag: string
  /** API-key scopes the tool needs. */
  scopes: readonly string[]
  /** Whether hosted OAuth MCP tokens may call it (false = API key only). */
  oauth: boolean
}

const FLAG = {
  brief: 'MEMORY_API_BRIEF_ENABLED',
  timeline: 'MEMORY_API_TIMELINE_ENABLED',
  people: 'MEMORY_API_PEOPLE_ENABLED',
  meetings: 'MEMORY_API_MEETINGS_ENABLED',
  inbox: 'MEMORY_API_INBOX_ENABLED',
} as const

export const PERSONAL_TOOL_INFO: Record<PersonalToolName, PersonalToolInfo> = {
  daily_brief: { feature: 'brief', envFlag: FLAG.brief, scopes: ['brief:read'], oauth: false },
  memory_timeline: { feature: 'timeline', envFlag: FLAG.timeline, scopes: ['timeline:read'], oauth: true },
  people_list: { feature: 'people', envFlag: FLAG.people, scopes: ['people:read'], oauth: false },
  people_get: { feature: 'people', envFlag: FLAG.people, scopes: ['people:read'], oauth: false },
  people_upsert: { feature: 'people', envFlag: FLAG.people, scopes: ['people:write'], oauth: false },
  reminder_create: { feature: 'people', envFlag: FLAG.people, scopes: ['reminders:write'], oauth: false },
  reminders_upcoming: { feature: 'people', envFlag: FLAG.people, scopes: ['reminders:read'], oauth: false },
  reminder_complete: { feature: 'people', envFlag: FLAG.people, scopes: ['reminders:write'], oauth: false },
  meeting_brief: { feature: 'meetings', envFlag: FLAG.meetings, scopes: ['meetings:read', 'answer:read'], oauth: false },
  meetings_upcoming: { feature: 'meetings', envFlag: FLAG.meetings, scopes: ['meetings:read'], oauth: false },
  memory_merge: { feature: 'inbox', envFlag: FLAG.inbox, scopes: ['memories:write', 'memories:delete'], oauth: false },
}

export function isPersonalTool(name: string): name is PersonalToolName {
  return (PERSONAL_TOOL_NAMES as readonly string[]).includes(name)
}

function needs(info: PersonalToolInfo): string {
  const key = info.oauth ? 'Requires' : 'API-key only (not available to hosted OAuth sessions); requires'
  return `${key} the ${info.scopes.join(' + ')} scope${info.scopes.length > 1 ? 's' : ''} and ${info.envFlag} on the API.`
}

// ---------------------------------------------------------------------------
// Zod inputs (runtime validation; `container` first).
// ---------------------------------------------------------------------------

const DailyBriefInput = z.object({
  container: containerField,
  date: ymdDate.optional().describe('Local day to brief, YYYY-MM-DD. Default: today in `timezone`.'),
  timezone: timezoneField,
  days: z.number().int().min(1).max(30).optional().describe('Reminder look-ahead window in days (default 7).'),
  sections: z
    .array(z.enum(['core', 'followUps', 'meetings']))
    .min(1)
    .optional()
    .describe('Sections to compose (default all). followUps runs the reader and is metered as one answer call.'),
})

const TimelineInput = z.object({
  container: containerField,
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  types: z
    .array(z.enum(['memory', 'reminder', 'document', 'event']))
    .min(1)
    .optional()
    .describe('Lanes to include (default memory, reminder, document; event is noisy and opt-in).'),
  direction: z.enum(['desc', 'asc']).optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1024).optional(),
})

const PeopleListInput = z.object({
  q: z.string().min(1).max(120).optional().describe('Match on display name or email.'),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(1024).optional(),
})

const slugField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase alphanumerics and single hyphens')

const PeopleGetInput = z.object({ slug: slugField.describe('Person slug, e.g. alice-smith.') })

const importantDate = z.object({
  label: z.string().min(1).max(60),
  date: ymdDate,
  recurring: z.boolean().default(false).describe('Recurs yearly (birthdays, anniversaries).'),
})

const PeopleUpsertInput = z.object({
  displayName: z.string().min(1).max(120),
  slug: slugField.optional().describe('Explicit slug. Derived from displayName when omitted; immutable after create.'),
  relationship: z.string().max(80).nullable().optional(),
  email: z.string().max(320).nullable().optional(),
  phone: z.string().max(40).nullable().optional().describe('E.164 preferred; cosmetic spaces/dashes are stripped.'),
  company: z.string().max(120).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  importantDates: z.array(importantDate).max(20).nullable().optional(),
  aliases: z.array(z.string().min(1).max(120)).max(10).nullable().optional(),
})

const ReminderCreateInput = z
  .object({
    container: containerField.describe('Container to file the reminder in. Omit with personSlug, or to use the default container.'),
    content: z.string().min(1).max(4000).describe('What to be reminded of.'),
    dueAt: isoDateTime,
    personSlug: slugField.optional().describe("File under this person's container. Mutually exclusive with container."),
    idempotencyKey: z.string().min(1).max(200).optional(),
    metadata: boundedMetadata.optional(),
  })
  .refine((v) => !(v.personSlug !== undefined && v.container !== undefined), {
    message: 'pass either personSlug or container, not both',
    path: ['personSlug'],
  })

const RemindersUpcomingInput = z.object({
  container: containerField.describe('Optional filter: only reminders in this container tag.'),
  days: z.number().int().min(1).max(90).optional().describe('Look-ahead window (default 7).'),
  timezone: timezoneField,
  containerType: z.string().min(1).max(64).optional().describe('Optional filter, e.g. person.'),
  limit: z.number().int().min(1).max(100).optional(),
})

const ReminderCompleteInput = z.object({
  id: z.string().min(1).max(256).describe('Reminder (memory) id.'),
})

const MeetingBriefInput = z.object({
  documentId: z.string().uuid().describe('Meeting document id from meetings_upcoming.'),
  q: z.string().min(1).max(2000).optional().describe('Your question; default asks what you know, last discussed and what is open.'),
})

const MeetingsUpcomingInput = z.object({
  container: containerField.describe("Optional filter: one calendar connection's container tag."),
  days: z.number().int().min(1).max(30).optional().describe('Look-ahead window (default 7).'),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(1024).optional(),
})

const MemoryMergeInput = z
  .object({
    container: containerField,
    ids: z
      .array(z.string().min(1).max(256))
      .min(2)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'ids must be unique' })
      .describe('2..20 memory ids in the same container. Every id not kept as `into` is soft-deleted.'),
    into: z.string().min(1).max(256).optional().describe('Survivor id (must be one of ids). Omit to write a new merged memory from content.'),
    content: z.string().min(1).max(4000).optional().describe('Merged text. Required when into is omitted.'),
    memoryType: z.string().min(1).max(100).optional(),
    metadata: boundedMetadata.optional(),
    mergeKey: z.string().min(1).max(200).optional().describe('Idempotency key; a replay returns the survivor with replayed=true.'),
  })
  .refine((v) => v.into !== undefined || v.content !== undefined, {
    message: 'content is required when into is omitted',
    path: ['content'],
  })
  .refine((v) => v.into === undefined || v.ids.includes(v.into), {
    message: 'into must be one of ids',
    path: ['into'],
  })

// ---------------------------------------------------------------------------
// ListTools definitions (JSON schema; `container` first).
// ---------------------------------------------------------------------------

const containerProp = { type: 'string', description: CONTAINER_DESCRIPTION } as const
const isoProp = { type: 'string', format: 'date-time' } as const
const nullableString = (maxLength: number, description?: string) => ({
  type: ['string', 'null'],
  maxLength,
  ...(description ? { description } : {}),
})

export const PERSONAL_TOOLS: Tool[] = [
  {
    name: 'daily_brief',
    description:
      `Compose today's brief for one memory container: overdue / due-today / coming-up reminders, people's important dates, what was captured in the last 24h, open follow-ups from the reader, and today's meetings. Read-only and never stored. ${needs(PERSONAL_TOOL_INFO.daily_brief)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: containerProp,
        date: { type: 'string', description: 'Local day, YYYY-MM-DD (default today).' },
        timezone: { type: 'string', description: 'IANA timezone (default UTC).' },
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        sections: { type: 'array', items: { type: 'string', enum: ['core', 'followUps', 'meetings'] } },
      },
    },
  },
  {
    name: 'memory_timeline',
    description:
      `Read one container as a single time-ordered stream of memories, open reminders (at due time), documents and optional engine events, cursor-paginated. ${needs(PERSONAL_TOOL_INFO.memory_timeline)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: containerProp,
        from: isoProp,
        to: isoProp,
        types: { type: 'array', items: { type: 'string', enum: ['memory', 'reminder', 'document', 'event'] } },
        direction: { type: 'string', enum: ['desc', 'asc'], default: 'desc' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'people_list',
    description: `List the people the workspace remembers (one memory container per person) with memory and open-reminder counts, newest first. ${needs(PERSONAL_TOOL_INFO.people_list)}`,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Match display name or email.' },
        includeArchived: { type: 'boolean', default: false },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'people_get',
    description: `Fetch one person by slug: contact details, important dates, aliases and counts. Their memories live in container person:<slug> (use memory_search / memory_timeline with that container). ${needs(PERSONAL_TOOL_INFO.people_get)}`,
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Person slug, e.g. alice-smith.' } },
      required: ['slug'],
    },
  },
  {
    name: 'people_upsert',
    description:
      `Create a person, or update them when one with the same slug already exists (slug = given, else derived from displayName). Omitted fields are untouched; explicit null clears a field; arrays replace wholesale. Returns {created, person}. ${needs(PERSONAL_TOOL_INFO.people_upsert)}`,
    inputSchema: {
      type: 'object',
      properties: {
        displayName: { type: 'string', maxLength: 120 },
        slug: { type: 'string', maxLength: 64, description: 'lowercase alphanumerics and single hyphens; immutable after create.' },
        relationship: nullableString(80, 'e.g. friend, client, manager'),
        email: nullableString(320),
        phone: nullableString(40, 'E.164 preferred.'),
        company: nullableString(120),
        notes: nullableString(4000),
        importantDates: {
          type: ['array', 'null'],
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', maxLength: 60 },
              date: { type: 'string', description: 'YYYY-MM-DD' },
              recurring: { type: 'boolean', default: false },
            },
            required: ['label', 'date'],
          },
        },
        aliases: { type: ['array', 'null'], maxItems: 10, items: { type: 'string' } },
      },
      required: ['displayName'],
    },
  },
  {
    name: 'reminder_create',
    description:
      `Create a reminder (a memory of type reminder with a due time). File it under a person with personSlug, in an explicit container, or in the default container. ${needs(PERSONAL_TOOL_INFO.reminder_create)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container to file the reminder in (mutually exclusive with personSlug).' },
        content: { type: 'string', maxLength: 4000 },
        dueAt: isoProp,
        personSlug: { type: 'string', description: "File under this person's container." },
        idempotencyKey: { type: 'string', maxLength: 200 },
        metadata: { type: 'object' },
      },
      required: ['content', 'dueAt'],
    },
  },
  {
    name: 'reminders_upcoming',
    description:
      `Open reminders bucketed into overdue / dueToday / upcoming by the caller's local day, plus people's important dates in the window. Workspace-wide across every container unless filtered. ${needs(PERSONAL_TOOL_INFO.reminders_upcoming)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Optional filter: only this container tag.' },
        days: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        timezone: { type: 'string', description: 'IANA timezone (default UTC).' },
        containerType: { type: 'string', description: 'Optional filter, e.g. person.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
    },
  },
  {
    name: 'reminder_complete',
    description: `Mark a reminder done: clears its due time and records completedAt. Already-completed reminders return 409. ${needs(PERSONAL_TOOL_INFO.reminder_complete)}`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Reminder (memory) id.' } },
      required: ['id'],
    },
  },
  {
    name: 'meeting_brief',
    description:
      `Pre-meeting brief for one calendar event: a reader answer (your q, or what you know / last discussed / what is open) with citations, each matched person with open reminders and recent memories, and previous meetings with the same attendees. Metered as one answer call on a cache miss. ${needs(PERSONAL_TOOL_INFO.meeting_brief)}`,
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', format: 'uuid', description: 'From meetings_upcoming.' },
        q: { type: 'string', maxLength: 2000 },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'meetings_upcoming',
    description:
      `Upcoming Google Calendar meetings across every connected calendar, soonest first, attendees resolved to people. Empty with connections: [] when no calendar is connected. ${needs(PERSONAL_TOOL_INFO.meetings_upcoming)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: "Optional filter: one calendar connection's container tag." },
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        cursor: { type: 'string' },
      },
    },
  },
  {
    name: 'memory_merge',
    description:
      `Fold 2..20 duplicate memories of one container into a single survivor: keep one with into (it gains metadata.mergedFromIds) or write a new merged memory from content. Every other id is soft-deleted (restorable). Idempotent on mergeKey. ${needs(PERSONAL_TOOL_INFO.memory_merge)}`,
    inputSchema: {
      type: 'object',
      properties: {
        container: containerProp,
        ids: { type: 'array', minItems: 2, maxItems: 20, items: { type: 'string' } },
        into: { type: 'string', description: 'Survivor id (one of ids).' },
        content: { type: 'string', maxLength: 4000, description: 'Merged text; required when into is omitted.' },
        memoryType: { type: 'string' },
        metadata: { type: 'object' },
        mergeKey: { type: 'string', maxLength: 200 },
      },
      required: ['ids'],
    },
  },
]

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * `slugify('José Álvarez') === 'jose-alvarez'` — mirrors the API's person
 * slug derivation so people_upsert can address the record a 409 points at.
 */
export function slugifyDisplayName(displayName: string): string {
  const ascii = displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (ascii.length <= 64) return ascii
  return ascii.slice(0, 64).replace(/-+$/g, '')
}

type UpsertResult = { created: boolean; person: PersonRecord }

async function upsertPerson(api: MnemoApiClient, raw: Record<string, unknown>): Promise<UpsertResult> {
  const i = PeopleUpsertInput.parse(raw)
  const { slug: explicitSlug, displayName, ...fields } = i
  const slug = explicitSlug ?? slugifyDisplayName(displayName)
  if (!slug) {
    throw new Error(`displayName '${displayName}' yields no usable slug — pass an explicit slug.`)
  }
  const patch: UpdatePersonInput = { displayName, ...fields }
  const create: CreatePersonInput = { ...(explicitSlug !== undefined ? { slug: explicitSlug } : {}), displayName, ...fields }

  if (explicitSlug !== undefined) {
    // The caller named the record: prefer updating it; create only when absent.
    try {
      return { created: false, person: await api.updatePerson(slug, patch) }
    } catch (err) {
      if (!(err instanceof MnemoApiError) || err.status !== 404) throw err
      return { created: true, person: await api.createPerson(create) }
    }
  }
  try {
    return { created: true, person: await api.createPerson(create) }
  } catch (err) {
    if (!(err instanceof MnemoApiError) || err.status !== 409) throw err
    try {
      return { created: false, person: await api.updatePerson(slug, patch) }
    } catch (patchErr) {
      if (patchErr instanceof MnemoApiError && patchErr.status === 404) {
        throw new Error(
          `A person named '${displayName}' already exists but not under slug '${slug}' — look them up with people_list and pass their slug explicitly.`,
        )
      }
      throw patchErr
    }
  }
}

export async function dispatchPersonalTool(
  api: MnemoApiClient,
  name: PersonalToolName,
  raw: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'daily_brief': {
      const i = DailyBriefInput.parse(raw)
      return api.getDailyBrief(i)
    }
    case 'memory_timeline': {
      const i = TimelineInput.parse(raw)
      return api.getTimeline(i)
    }
    case 'people_list': {
      const i = PeopleListInput.parse(raw)
      return api.listPeople(i)
    }
    case 'people_get': {
      const i = PeopleGetInput.parse(raw)
      return api.getPerson(i.slug)
    }
    case 'people_upsert':
      return upsertPerson(api, raw)
    case 'reminder_create': {
      const i = ReminderCreateInput.parse(raw)
      return api.createReminder(i)
    }
    case 'reminders_upcoming': {
      const i = RemindersUpcomingInput.parse(raw)
      return api.listUpcomingReminders(i)
    }
    case 'reminder_complete': {
      const i = ReminderCompleteInput.parse(raw)
      return api.completeReminder(i.id)
    }
    case 'meeting_brief': {
      const i = MeetingBriefInput.parse(raw)
      return api.getMeetingBrief(i.documentId, i.q)
    }
    case 'meetings_upcoming': {
      const i = MeetingsUpcomingInput.parse(raw)
      return api.listUpcomingMeetings(i)
    }
    case 'memory_merge': {
      const i = MemoryMergeInput.parse(raw)
      return api.mergeMemories(i)
    }
    default: {
      const unreachable: never = name
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${String(unreachable)}`)
    }
  }
}

/**
 * Tool-error text for a personal-memory tool. Names the deployment flag on
 * 503 FEATURE_DISABLED, the scope(s) on 403, and surfaces stable codes.
 */
export function formatPersonalApiError(err: MnemoApiError, name: PersonalToolName): string {
  const info = PERSONAL_TOOL_INFO[name]
  const scopes = info.scopes.join(' + ')
  const code = err.code ? ` ${err.code}` : ''
  if (err.status === 503) {
    return `Mnemo API error (503${code}): the ${info.feature} feature is disabled on this API deployment — the operator must set ${info.envFlag}=1. ${err.message}`
  }
  if (err.status === 403) {
    if (/MCP tokens/i.test(err.message)) {
      return `Mnemo API error (403): ${name} is only available to API key connections (stdio / private HTTP with a key holding ${scopes}); hosted OAuth MCP sessions cannot use it.`
    }
    if (/scope/i.test(err.message)) {
      return `Mnemo API error (403): the API key lacks a required scope — ${name} needs ${scopes}. ${err.message}`
    }
    return `Mnemo API error (403${code}): ${err.message}`
  }
  if (err.status === 400 && err.code === 'CONTAINER_TAG_REQUIRED') {
    return `Mnemo API error (400 CONTAINER_TAG_REQUIRED): this connection has no default container — pass \`container\` to target one. ${err.message}`
  }
  return `Mnemo API error (${err.status}${code}): ${err.message}`
}
