/**
 * Thin REST client for the Mnemo Memory API.
 *
 * This duplicates the surface area we need for MCP tools — we deliberately
 * do NOT depend on getmnemo here so this server can ship even if
 * the JS SDK lags behind. When the SDK stabilises, swap this for it.
 *
 * Contract pinned to the prod OpenAPI spec ("Mnemo API" v0.2.0,
 * https://api.mnemohq.com/openapi.json). See SDK_RECONCILIATION_0.2.0.md.
 *
 * SECURITY: the tenant boundary (`containerTag` or structured `scope`) is
 * supplied once at construction from SERVER CONFIG/ENV as the DEFAULT
 * container. For the hosted multi-container model a caller MAY additionally
 * request a specific container per call; that request is sent as the
 * `X-Mnemo-Container` header and is VALIDATED SERVER-SIDE against the
 * connection's allowed set (403 out-of-scope, 400 write-needs-container).
 * The model can only target containers the connection already permits.
 */

import type {
  CreatePersonInput,
  CreateReminderInput,
  DailyBrief,
  DailyBriefInput,
  ListPeopleInput,
  ListPeopleResponse,
  MeetingBrief,
  MergeMemoriesInput,
  MergeMemoriesResponse,
  PersonRecord,
  ReminderRecord,
  TimelineInput,
  TimelineResponse,
  UpcomingMeetingsInput,
  UpcomingMeetingsResponse,
  UpcomingRemindersInput,
  UpcomingRemindersResponse,
  UpdatePersonInput,
} from './personal-types.js'

/** Header the API reads to target a specific allowed container per call. */
export const CONTAINER_HEADER = 'x-mnemo-container'

/**
 * Per-request budget for /v1/answer. The full synthesis pipeline (retrieval +
 * two-stage reader) can legitimately outlive the default 30s request timeout,
 * so answer calls get their own ceiling instead of failing as aborts.
 */
export const ANSWER_TIMEOUT_MS = 90_000

// confirmed against prod 2026-06-16. Shapes verified from real /v1 payloads.
export type Memory = {
  id: string
  scope?: unknown
  scopeKey?: string
  container?: {
    id?: string
    tag?: string
    containerType?: string
    displayName?: string
  }
  content: string
  contentHash?: string
  idempotencyKey?: string
  memoryType?: string
  metadata?: Record<string, unknown>
  source?: string
  sourceDocumentId?: string | null
  eventId?: string | null
  deletedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

// confirmed against prod 2026-06-16. Live search hit shape.
export type SearchHit = {
  resultType?: string
  memoryId: string
  scopeKey?: string
  content: string
  metadata?: Record<string, unknown>
  memoryType?: string
  polarity?: string
  score: number
  createdAt?: string
  updatedAt?: string
}

// confirmed against prod 2026-06-16. Search returns `{ results: [...] }`
// (NOT `hits`), plus preference/constraint buckets and search diagnostics.
export type SearchResponse = {
  results: SearchHit[]
  positivePreferences?: SearchHit[]
  hardConstraints?: SearchHit[]
  searchMode?: string
  queryIntent?: string
  queryIntentConfidence?: number
  abstained?: boolean
  reranked?: boolean
  rawBestVectorSim?: number
  latency?: {
    parallelMs?: number
    strategyMs?: number
    fusionMs?: number
    rerankerMs?: number
    totalMs?: number
  }
}

// confirmed against prod 2026-06-16. Add response envelope.
export type AddResponse = {
  scopeKey?: string
  scope?: unknown
  items: Memory[]
}

// POST /v1/answer result (AnswerResult in the API). Citations only present
// when includeCitations was requested.
export type AnswerCitation = {
  type?: string
  score?: number
  content?: string
  memoryId?: string
  documentId?: string
  sessionDate?: string
}

export type AnswerResponse = {
  answer: string
  abstained?: boolean
  queryIntent?: string
  isAggregation?: boolean
  fallbackTriggered?: boolean
  retryTriggered?: boolean
  citations?: AnswerCitation[]
  stats?: Record<string, unknown>
}

// GET /v1/jobs/{jobId} — ingestion job record (JobRecordDto).
export type JobRecord = {
  id: string
  status: string
  documentId?: string
  retryable?: boolean
  attempts?: { current: number; max: number }
  error?: { code: string | null; message: string | null } | null
  startedAt?: string | null
  finishedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

// POST /v1/documents — stored document plus the queued ingestion job.
export type CreateDocumentResponse = {
  documentId: string
  jobId: string
  status: string
  reused?: boolean
  document?: Record<string, unknown>
  job?: JobRecord
}

export type Polarity = 'positive' | 'negative' | 'neutral'

export type MemorySource = Record<string, unknown>

/**
 * The tenant boundary. Exactly one form is configured server-side:
 *  - `containerTag`: the "user:jane" string form (preferred, simpler), OR
 *  - `scope`: the structured `{ type, id }` form.
 * Both map to the same backend container; we thread whichever is set.
 */
export type ContainerScope =
  | { containerTag: string; scope?: never }
  | { containerTag?: never; scope: { type: string; id: string } }

export type ProcedurePage = {
  items: Array<Record<string, unknown>>
  nextCursor: string | null
}

export type ProcedureAskResponse = {
  answer: string
  abstained: boolean
  citations: Array<{ title: string | null; url: string | null; app: string | null; content: string; score: number }>
}

export type ApiClientConfig = {
  baseUrl: string
  apiKey: string
  /** Optional. The tenant is implied by the API key; this only pins it. */
  workspaceId?: string
  /**
   * DEFAULT tenant boundary, supplied at server startup (env) or from an
   * OAuth grant. Local (stdio/header) mode REQUIRES it — every call is pinned
   * to it unless a validated per-call container overrides. Hosted OAuth mode
   * MAY leave it UNSET for "all containers" or multi-container grants: the API
   * then resolves scope from the grant, and a per-call `X-Mnemo-Container`
   * header targets a specific container. Never a model-set boundary.
   */
  container?: ContainerScope
  fetch?: typeof fetch
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number
}

export class MnemoApiError extends Error {
  /**
   * Stable machine-readable code from the API error envelope
   * (`FEATURE_DISABLED`, `PERSON_NOT_FOUND`, `NOT_A_REMINDER`, ...). Only
   * the personal-memory routes emit one; undefined otherwise.
   */
  readonly code: string | undefined

  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MnemoApiError'
    this.code = errorCodeOf(body)
  }
}

function errorCodeOf(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return undefined
}

export class MnemoApiClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  /**
   * Default tenant boundary, threaded into every request that lacks a
   * per-call override. Undefined only in hosted OAuth mode (all/multi grants),
   * where the API resolves scope from the grant + per-call header.
   */
  private readonly container?: ContainerScope

  constructor(cfg: ApiClientConfig) {
    if (!cfg.apiKey) throw new Error('apiKey is required')
    // A default container is optional (hosted OAuth all/multi grants omit it),
    // but if one IS supplied it must be a valid form.
    if (cfg.container && !cfg.container.containerTag && !cfg.container.scope) {
      throw new Error('container, when set, must have a containerTag or scope')
    }
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    // The API derives the tenant from the key; `x-workspace-id` was retired
    // (SDK 0.5.1 dropped it and asserts it is null). It is sent ONLY when a
    // workspace is explicitly configured, so an operator can still pin one
    // against an older deployment without every integrator being forced to
    // find an id they do not need. Resolve it from the key with whoAmI().
    this.headers = {
      'authorization': `Bearer ${cfg.apiKey}`,
      ...(cfg.workspaceId ? { 'x-workspace-id': cfg.workspaceId } : {}),
      'content-type': 'application/json',
      'user-agent': '@mnemo/mcp-server',
    }
    this.container = cfg.container
    this.fetchImpl = cfg.fetch ?? fetch
    this.timeoutMs = cfg.timeoutMs ?? 30_000
  }

  /**
   * Spreads the effective tenant boundary into a request body. A per-call
   * `override` container tag (validated server-side) wins over the configured
   * default; otherwise exactly one of `containerTag` / `scope` is present.
   */
  private containerBody(override?: string): Record<string, unknown> {
    if (override !== undefined) return { containerTag: override }
    if (this.container?.containerTag !== undefined) return { containerTag: this.container.containerTag }
    if (this.container?.scope) return { scope: this.container.scope }
    // Unset (hosted all/multi grant): the API resolves scope from the grant.
    return {}
  }

  /**
   * Key introspection — GET /v1/whoami. Resolves the workspace (and the scopes)
   * the presented key actually holds, so a caller never has to configure a
   * workspace id by hand. Requires no scope beyond a valid key.
   */
  async whoAmI(): Promise<{
    workspaceId: string
    workspaceName: string | null
    keyId: string
    keyName: string | null
    scopes: string[]
  }> {
    return this.request('GET', '/v1/whoami')
  }

  async search(input: {
    query: string
    limit?: number
    container?: string
    polarity?: Polarity
    searchMode?: 'hybrid' | 'memories' | 'documents'
    excludeIds?: string[]
    mode?: 'fast' | 'precise'
  }): Promise<SearchResponse> {
    // SearchRequestDto: field is `q` (NOT `query`); containerTag|scope required.
    // Optional fields are only sent when set — the API 400s unknown properties,
    // so an absent field must stay absent for older servers.
    return this.request<SearchResponse>(
      'POST',
      '/v1/search',
      {
        q: input.query,
        ...this.containerBody(input.container),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.polarity !== undefined ? { polarity: input.polarity } : {}),
        ...(input.searchMode !== undefined ? { searchMode: input.searchMode } : {}),
        ...(input.excludeIds !== undefined ? { excludeIds: input.excludeIds } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      },
      input.container,
    )
  }

  /**
   * POST /v1/answer — the cited-answer pipeline: hybrid retrieval + synthesis
   * over the effective container. Citations default ON server-side (the whole
   * point of the tool); `mode: 'fast'` trades depth for ~1-2s latency. The
   * full pipeline can run well past the default request timeout, so answer
   * calls get their own longer budget.
   */
  async answerQuestion(input: {
    question: string
    limit?: number
    mode?: 'fast' | 'full'
    includeCitations?: boolean
    referenceDate?: string
    container?: string
  }): Promise<AnswerResponse> {
    return this.request<AnswerResponse>(
      'POST',
      '/v1/answer',
      {
        q: input.question,
        ...this.containerBody(input.container),
        // The controller itself defaults `dto.includeCitations ?? true`, so
        // omitting the key keeps citations ON while preserving the invariant
        // that unset fields never reach older servers.
        ...(input.includeCitations !== undefined ? { includeCitations: input.includeCitations } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.referenceDate !== undefined ? { referenceDate: input.referenceDate } : {}),
      },
      input.container,
      // Respect an operator-configured budget when it is already longer.
      Math.max(ANSWER_TIMEOUT_MS, this.timeoutMs),
    )
  }

  /**
   * POST /v1/documents — async ingestion lane for raw source material
   * (transcripts, pages, notes; hard cap 500,000 characters). Returns the
   * stored document and the queued job; poll getJob() until it completes.
   * Re-uploading the same customId updates the existing document instead of
   * duplicating it.
   */
  async addDocument(input: {
    content: string
    contentType: string
    customId?: string
    metadata?: Record<string, unknown>
    container?: string
  }): Promise<CreateDocumentResponse> {
    return this.request<CreateDocumentResponse>(
      'POST',
      '/v1/documents',
      {
        content: input.content,
        contentType: input.contentType,
        ...this.containerBody(input.container),
        ...(input.customId !== undefined ? { customId: input.customId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
      input.container,
    )
  }

  /** GET /v1/jobs/{jobId} — status of one ingestion job (workspace-keyed). */
  async getJob(jobId: string): Promise<JobRecord> {
    return this.request<JobRecord>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`)
  }

  /**
   * POST /v1/memories/{memoryId}/restore — undo a recoverable delete while
   * its window is open. Addressed by bare memory id (no container field), so
   * the API rejects hosted-OAuth MCP principals outright; API-key connections
   * only. 409 when the receipt is no longer restorable.
   */
  async restoreMemory(
    memoryId: string,
  ): Promise<{ id: string; restored: true; receiptId?: string; restoredAt?: string }> {
    return this.request('POST', `/v1/memories/${encodeURIComponent(memoryId)}/restore`)
  }

  async addMemory(input: {
    content: string
    memoryType?: string
    polarity?: Polarity
    metadata?: Record<string, unknown>
    source?: MemorySource
    idempotencyKey?: string
    container?: string
  }): Promise<AddResponse> {
    // CreateMemoriesDto: content wrapped in `items[]`; containerTag|scope
    // required at runtime (DTO marks only `items`, but prod 400s without it).
    // `polarity` declares the writer's intent (a hard constraint is
    // `negative`) and beats the server's phrasing classifier; only sent when
    // set so older servers never see the key.
    return this.request<AddResponse>(
      'POST',
      '/v1/memories',
      {
        items: [
          {
            content: input.content,
            ...(input.memoryType !== undefined ? { memoryType: input.memoryType } : {}),
            ...(input.polarity !== undefined ? { polarity: input.polarity } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          },
        ],
        ...this.containerBody(input.container),
      },
      input.container,
    )
  }

  async updateMemory(
    memoryId: string,
    input: {
      content?: string
      memoryType?: string
      polarity?: Polarity
      metadata?: Record<string, unknown> | null
      source?: MemorySource | null
    },
    container?: string,
  ): Promise<Memory> {
    // UpdateMemoryDto: {content?, memoryType?, polarity?, metadata?, source?}
    // — all optional; JSON.stringify drops the undefined ones, so older
    // servers never see keys the caller did not set. An explicit `polarity`
    // wins over re-classification of edited content. Direct access is
    // additionally pinned by the effective scope
    // query so same-workspace containers cannot cross read/write boundaries.
    return this.request<Memory>(
      'PATCH',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      input,
      container,
    )
  }

  async getMemory(memoryId: string, container?: string): Promise<Memory> {
    return this.request<Memory>(
      'GET',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      undefined,
      container,
    )
  }

  async deleteMemory(memoryId: string, container?: string): Promise<{ id: string; deleted: true }> {
    return this.request<{ id: string; deleted: true }>(
      'DELETE',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      undefined,
      container,
    )
  }

  /**
   * Query-string form of the effective tenant boundary (per-call override,
   * else the configured default, else nothing for hosted all/multi grants).
   */
  private containerParams(override?: string): URLSearchParams {
    const params = new URLSearchParams()
    if (override !== undefined) {
      params.set('containerTag', override)
    } else if (this.container?.containerTag !== undefined) {
      params.set('containerTag', this.container.containerTag)
    } else if (this.container?.scope) {
      params.set('scopeType', this.container.scope.type)
      params.set('scopeId', this.container.scope.id)
    }
    return params
  }

  private containerQuery(override?: string): string {
    return queryString(this.containerParams(override))
  }

  async listMemories(input?: {
    limit?: number
    cursor?: string
    container?: string
  }): Promise<{ items: Memory[]; nextCursor: string | null }> {
    // GET /v1/memories filters by containerTag (or scopeType+scopeId), NOT
    // actorId. Thread the effective container (per-call override or default).
    const params = this.containerParams(input?.container)
    if (input?.limit !== undefined) params.set('limit', String(input.limit))
    if (input?.cursor !== undefined) params.set('cursor', input.cursor)
    return this.request('GET', `/v1/memories${queryString(params)}`, undefined, input?.container)
  }

  // ---------------------------------------------------------------------
  // Personal-memory surface (API v0.3.0). Container-scoped reads (brief,
  // timeline, merge) thread the effective container like the memory ops.
  // People, reminders and meetings are cross-container by nature: the
  // configured default is NOT applied to them, only an explicit filter.
  // ---------------------------------------------------------------------

  /** GET /v1/brief — the composed day for one container. */
  async getDailyBrief(input: DailyBriefInput): Promise<DailyBrief> {
    const params = this.containerParams(input.container)
    setParam(params, 'date', input.date)
    setParam(params, 'timezone', input.timezone)
    setParam(params, 'days', input.days)
    setParam(params, 'sections', input.sections?.join(','))
    return this.request<DailyBrief>('GET', `/v1/brief${queryString(params)}`, undefined, input.container)
  }

  /** GET /v1/timeline — one container as a single time-ordered stream. */
  async getTimeline(input: TimelineInput): Promise<TimelineResponse> {
    const params = this.containerParams(input.container)
    setParam(params, 'from', input.from)
    setParam(params, 'to', input.to)
    setParam(params, 'types', input.types?.join(','))
    setParam(params, 'direction', input.direction)
    setParam(params, 'limit', input.limit)
    setParam(params, 'cursor', input.cursor)
    return this.request<TimelineResponse>('GET', `/v1/timeline${queryString(params)}`, undefined, input.container)
  }

  /** GET /v1/people */
  async listPeople(input: ListPeopleInput = {}): Promise<ListPeopleResponse> {
    const params = new URLSearchParams()
    setParam(params, 'q', input.q)
    setParam(params, 'includeArchived', input.includeArchived)
    setParam(params, 'limit', input.limit)
    setParam(params, 'cursor', input.cursor)
    return this.request<ListPeopleResponse>('GET', `/v1/people${queryString(params)}`)
  }

  /** GET /v1/people/{slug} */
  async getPerson(slug: string): Promise<PersonRecord> {
    return this.request<PersonRecord>('GET', `/v1/people/${encodeURIComponent(slug)}`)
  }

  /** POST /v1/people */
  async createPerson(input: CreatePersonInput): Promise<PersonRecord> {
    return this.request<PersonRecord>('POST', '/v1/people', compact(input))
  }

  /** PATCH /v1/people/{slug} — explicit `null` clears a field. */
  async updatePerson(slug: string, input: UpdatePersonInput): Promise<PersonRecord> {
    return this.request<PersonRecord>('PATCH', `/v1/people/${encodeURIComponent(slug)}`, compact(input))
  }

  /** POST /v1/reminders — personSlug, else container (per-call or default). */
  async createReminder(input: CreateReminderInput): Promise<ReminderRecord> {
    const { personSlug, container, ...rest } = input
    const target = personSlug !== undefined ? { personSlug } : this.containerBody(container)
    return this.request<ReminderRecord>('POST', '/v1/reminders', { ...compact(rest), ...target }, container)
  }

  /** GET /v1/reminders/upcoming — workspace-wide unless a container filter is given. */
  async listUpcomingReminders(input: UpcomingRemindersInput = {}): Promise<UpcomingRemindersResponse> {
    const params = new URLSearchParams()
    setParam(params, 'days', input.days)
    setParam(params, 'timezone', input.timezone)
    setParam(params, 'containerType', input.containerType)
    setParam(params, 'containerTag', input.container)
    setParam(params, 'limit', input.limit)
    return this.request<UpcomingRemindersResponse>('GET', `/v1/reminders/upcoming${queryString(params)}`)
  }

  /** POST /v1/reminders/{memoryId}/complete */
  async completeReminder(memoryId: string): Promise<ReminderRecord> {
    return this.request<ReminderRecord>('POST', `/v1/reminders/${encodeURIComponent(memoryId)}/complete`)
  }

  /** GET /v1/meetings/upcoming */
  async listUpcomingMeetings(input: UpcomingMeetingsInput = {}): Promise<UpcomingMeetingsResponse> {
    const params = new URLSearchParams()
    setParam(params, 'days', input.days)
    setParam(params, 'limit', input.limit)
    setParam(params, 'cursor', input.cursor)
    setParam(params, 'containerTag', input.container)
    return this.request<UpcomingMeetingsResponse>('GET', `/v1/meetings/upcoming${queryString(params)}`)
  }

  /** GET /v1/meetings/{documentId}/brief */
  async getMeetingBrief(documentId: string, q?: string): Promise<MeetingBrief> {
    const params = new URLSearchParams()
    setParam(params, 'q', q)
    return this.request<MeetingBrief>(
      'GET',
      `/v1/meetings/${encodeURIComponent(documentId)}/brief${queryString(params)}`,
    )
  }

  /** POST /v1/memories/merge — needs memories:write AND memories:delete. */
  async mergeMemories(input: MergeMemoriesInput): Promise<MergeMemoriesResponse> {
    const { container, ...rest } = input
    return this.request<MergeMemoriesResponse>(
      'POST',
      '/v1/memories/merge',
      { ...compact(rest), ...this.containerBody(container) },
      container,
    )
  }

  /** GET /v1/procedures — published procedures, most recently seen first. Needs memories:read. */
  async listProcedures(input: { app?: string; limit?: number; cursor?: string } = {}): Promise<ProcedurePage> {
    const params = new URLSearchParams()
    setParam(params, 'app', input.app)
    setParam(params, 'limit', input.limit)
    setParam(params, 'cursor', input.cursor)
    return this.request<ProcedurePage>('GET', `/v1/procedures${queryString(params)}`)
  }

  /** GET /v1/procedures/:id — one published procedure with its versions. Needs memories:read. */
  async getProcedure(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('GET', `/v1/procedures/${encodeURIComponent(id)}`)
  }

  /** POST /v1/procedures/ask — answered from published procedures only. Needs search:read. */
  async askProcedures(q: string): Promise<ProcedureAskResponse> {
    return this.request<ProcedureAskResponse>('POST', '/v1/procedures/ask', { q })
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    containerHeader?: string,
    timeoutMs?: number,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.timeoutMs)
    try {
      // Per-call container targeting: when present, the API validates this
      // header against the connection's allowed set. When absent, no header
      // is sent and the API falls back to the connection's allowed set.
      const headers =
        containerHeader !== undefined
          ? { ...this.headers, [CONTAINER_HEADER]: containerHeader }
          : { ...this.headers }
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const parsed = text ? safeJson(text) : undefined
      if (!res.ok) {
        const msg =
          (parsed && typeof parsed === 'object' && 'message' in parsed
            ? String((parsed as { message: unknown }).message)
            : null) ?? `HTTP ${res.status} ${res.statusText}`
        throw new MnemoApiError(msg, res.status, parsed)
      }
      if (parsed !== undefined && typeof parsed !== 'object') {
        throw new MnemoApiError(
          `Expected JSON object response, got: ${typeof parsed}`,
          res.status,
          parsed,
        )
      }
      return parsed as T
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Set a query param when defined; numbers/booleans are stringified (`'true'|'false'`). */
function setParam(params: URLSearchParams, key: string, value: string | number | boolean | undefined): void {
  if (value === undefined) return
  params.set(key, String(value))
}

function queryString(params: URLSearchParams): string {
  const query = params.toString()
  return query ? `?${query}` : ''
}

/** Drop `undefined` members so the API's forbidNonWhitelisted pipe never sees stray keys. */
function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
