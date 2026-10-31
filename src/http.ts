/**
 * Streamable HTTP entry point for hosted MCP clients.
 *
 * Supports public OAuth access tokens and private API-key sessions. Public
 * OAuth sessions derive workspace/container scope from Mnemo's grant; the
 * MCP client cannot provide or change that scope.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { modelTimeoutFromEnv, resolveContainerFromEnv, resolveContainerFromHeaders } from './config.js'
import type { ContainerScope } from './api-client.js'

type EnvLike = Record<string, string | undefined>
const DEFAULT_API_URL = process.env.GETMNEMO_API_URL ?? 'https://api.mnemohq.com'
const DEFAULT_RESOURCE_URL = 'https://mcp.mnemohq.com/mcp'
const DEFAULT_AUTHORIZATION_SERVER = 'https://api.mnemohq.com/v1/mcp/oauth'

export interface OAuthIdentifiers {
  /** RFC 9728 `resource`: the MCP URL the client connected to. */
  resource: string
  /** The authorization server issuer advertised in `authorization_servers`. */
  authorizationServer: string
  /** Where this resource's metadata lives; sent as `resource_metadata` on a 401. */
  resourceMetadataUrl: string
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The OAuth identifiers to advertise for a request.
 *
 *   MCP_RESOURCE_URL          primary resource (default https://mcp.mnemohq.com/mcp)
 *   MCP_AUTHORIZATION_SERVER  issuer (default https://api.mnemohq.com/v1/mcp/oauth)
 *   MCP_LEGACY_RESOURCE_URLS  optional comma-separated resources still served
 *                             after a host move. A request whose Host equals
 *                             one of these URLs' host is told THAT resource, so
 *                             a client connected to the old host still sees a
 *                             matching `resource`. The Host header only picks
 *                             among configured values; anything else gets the
 *                             primary.
 */
export function oauthIdentifiersFor(host: string | undefined, env: EnvLike = process.env): OAuthIdentifiers {
  const primary = env.MCP_RESOURCE_URL?.trim() || DEFAULT_RESOURCE_URL
  const authorizationServer = env.MCP_AUTHORIZATION_SERVER?.trim() || DEFAULT_AUTHORIZATION_SERVER
  const requestHost = host?.trim().toLowerCase()
  const legacy = (env.MCP_LEGACY_RESOURCE_URLS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  const matched = requestHost ? legacy.find((url) => hostOf(url) === requestHost) : undefined
  const resource = matched ?? primary
  return {
    resource,
    authorizationServer,
    resourceMetadataUrl: `${new URL(resource).origin}/.well-known/oauth-protected-resource`,
  }
}

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim() || undefined
  const legacy = req.headers['x-getmnemo-api-key']
  return typeof legacy === 'string' ? legacy.trim() || undefined : undefined
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}

/** Seconds a client should wait before retrying after a 503. */
const RETRY_AFTER_SECONDS = '5'

/**
 * The API could not answer the token check (down, restarting, overloaded or
 * rate limiting). Temporary: 503 with Retry-After, and no invalid_token
 * challenge, so clients keep their token instead of signing in again.
 */
function unavailable(res: ServerResponse): void {
  res.setHeader('retry-after', RETRY_AFTER_SECONDS)
  reject(res, 503, 'Memory service is temporarily unavailable. Try again shortly.')
}

/** API answers that mean "not now" rather than "this token is bad". */
function isTemporaryFailure(status: number): boolean {
  return status === 429 || status >= 500
}

function resolveRequestContainer(req: IncomingMessage, env: EnvLike): ContainerScope | null {
  if (env.GETMNEMO_ALLOW_HEADER_SCOPE !== '1') return resolveContainerFromEnv(env)
  return resolveContainerFromHeaders(
    headerValue(req, 'x-getmnemo-container-tag'),
    headerValue(req, 'x-getmnemo-scope-type'),
    headerValue(req, 'x-getmnemo-scope-id'),
    env,
  )
}

/**
 * Determine the DEFAULT container to pin for an OAuth grant, from the
 * introspection record.
 *
 * - `containerTags` array present: pin ONLY when the grant is scoped to
 *   exactly one container. For "all containers" (`[]`) or multi-container
 *   (length > 1) grants, return `undefined` — leave the default unset so the
 *   API resolves scope from the grant, with per-call `X-Mnemo-Container`
 *   selecting a specific container.
 * - No `containerTags` array (older API): fall back to the legacy single
 *   `containerTag` string when present.
 *
 * Returning `undefined` is a valid, expected outcome — NOT an error.
 */
export function pinnedContainerFromGrant(
  record: Record<string, unknown>,
): ContainerScope | undefined {
  const rawTags = record.containerTags
  if (Array.isArray(rawTags)) {
    const tags = rawTags.filter((t): t is string => typeof t === 'string' && t.length > 0)
    if (tags.length === 1) {
      const [only] = tags
      return only ? { containerTag: only } : undefined
    }
    return undefined
  }
  const legacy = typeof record.containerTag === 'string' && record.containerTag.length > 0
    ? record.containerTag
    : undefined
  return legacy ? { containerTag: legacy } : undefined
}

export function createMcpHttpServer(env: EnvLike = process.env) {
  const apiUrl = env.GETMNEMO_API_URL ?? DEFAULT_API_URL
  const modelTimeoutMs = modelTimeoutFromEnv(env)
  // Fail at startup, not per request, if MCP_RESOURCE_URL is not a URL.
  oauthIdentifiersFor(undefined, env)

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ status: 'ok', service: 'getmnemo-mcp', transport: 'streamable-http' }))
      return
    }
    const oauth = oauthIdentifiersFor(req.headers.host, env)
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      // Varies by Host (legacy hosts get their own resource), so caches must key on it.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300', vary: 'Host' })
      res.end(JSON.stringify({
        resource: oauth.resource,
        authorization_servers: [oauth.authorizationServer],
        scopes_supported: ['memories:read', 'memories:write', 'memories:delete', 'search:read'],
        bearer_methods_supported: ['header'],
      }))
      return
    }
    if (url.pathname !== '/mcp') {
      reject(res, 404, 'Not found. Use POST or GET /mcp.')
      return
    }
    if (!['GET', 'POST'].includes(req.method ?? '')) {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    const credential = bearerToken(req)
    if (!credential) {
      res.setHeader('WWW-Authenticate', `Bearer realm="mcp", scope="memories:read memories:write memories:delete search:read", resource_metadata="${oauth.resourceMetadataUrl}"`)
      reject(res, 401, 'OAuth authorization is required. Connect this MCP server from a client that supports remote OAuth.')
      return
    }

    let workspaceId: string | undefined
    // `undefined` default container is valid for OAuth all/multi-container
    // grants (the API resolves scope from the grant + per-call header).
    let container: ContainerScope | undefined
    const isOAuthToken = credential.split('.').length === 3
    if (isOAuthToken) {
      let introspection: Response
      try {
        introspection = await fetch(`${apiUrl}/v1/mcp/oauth/introspect`, {
          headers: { authorization: `Bearer ${credential}` },
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        unavailable(res)
        return
      }
      if (isTemporaryFailure(introspection.status)) {
        unavailable(res)
        return
      }
      if (!introspection.ok) {
        res.setHeader('WWW-Authenticate', `Bearer realm="mcp", error="invalid_token", resource_metadata="${oauth.resourceMetadataUrl}"`)
        reject(res, 401, 'The MCP authorization token is invalid or expired.')
        return
      }
      let identity: unknown
      try {
        identity = await introspection.json()
      } catch {
        unavailable(res)
        return
      }
      if (!identity || typeof identity !== 'object') {
        reject(res, 401, 'Invalid MCP authorization response.')
        return
      }
      const record = identity as Record<string, unknown>
      workspaceId = typeof record.tenantId === 'string' ? record.tenantId : undefined
      container = workspaceId ? pinnedContainerFromGrant(record) : undefined
      // OAuth requires only a workspace; the container may be unset (all/multi
      // grant). A write with no per-call container then gets the API's friendly
      // "specify a target container" error at tool time — NOT a setup failure.
      if (!workspaceId) {
        reject(res, 400, 'The MCP authorization grant has no valid workspace scope.')
        return
      }
    } else {
      workspaceId = headerValue(req, 'x-getmnemo-workspace-id') ?? env.GETMNEMO_WORKSPACE_ID
      container = resolveRequestContainer(req, env) ?? undefined
      // Local (env/header) mode still requires an explicit container boundary.
      if (!workspaceId || !container) {
        reject(res, 400, 'The MCP authorization grant has no valid workspace/container scope.')
        return
      }
    }

    // Stateless mode is intentional for the public service: no in-memory
    // session map means Azure replicas can serve subsequent MCP requests
    // without sticky routing or shared session storage.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    // OAuth sessions do not see the API-key-only personal-memory tools: the
    // API denies MCP tokens on every cross-container route.
    const server = createServer(
      { baseUrl: apiUrl, apiKey: credential, workspaceId, container, modelTimeoutMs },
      { principal: isOAuthToken ? 'oauth' : 'api_key' },
    )
    await server.connect(transport)
    await transport.handleRequest(req, res)
    await server.close()
  }

  // A request that fails must never take the process (and every other
  // agent's request) down with it: answer what can still be answered.
  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(`MCP request failed: ${error instanceof Error ? error.message : String(error)}\n`)
      if (!res.headersSent) reject(res, 500, 'Internal error.')
      else res.destroy()
    })
  })

  return httpServer
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787)
  const server = createMcpHttpServer()
  server.listen(port, () => process.stdout.write(`Mnemo MCP HTTP listening on :${port}\n`))
  const shutdown = (): void => {
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
