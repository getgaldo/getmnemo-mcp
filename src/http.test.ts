import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpHttpServer, oauthIdentifiersFor, pinnedContainerFromGrant } from './http.js'

function call(port: number, options: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp', ...options }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('hosted MCP HTTP entry point', () => {
  it('requires a configured tenant boundary', async () => {
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const result = await call(address.port, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'x-getmnemo-workspace-id': 'workspace' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    expect(result.status).toBe(400)
  })

  it('serves a health response without exposing credentials', async () => {
    const server = createMcpHttpServer({ GETMNEMO_CONTAINER_TAG: 'user:test' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/healthz' }, (res) => {
        let body = ''
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    expect(JSON.parse(result)).toEqual({ status: 'ok', service: 'getmnemo-mcp', transport: 'streamable-http' })
  })
})

describe('pinnedContainerFromGrant', () => {
  it('pins exactly-one-container grants', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTags: ['team:acme'] })).toEqual({
      containerTag: 'team:acme',
    })
  })

  it('does NOT pin an "all containers" grant (containerTags: [])', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTag: null, containerTags: [] })).toBeUndefined()
  })

  it('does NOT pin a multi-container grant (length > 1)', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTags: ['a', 'b'] })).toBeUndefined()
  })

  it('falls back to the legacy single containerTag when no array is present', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTag: 'user:jane' })).toEqual({
      containerTag: 'user:jane',
    })
  })

  it('returns undefined when neither form is present', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws' })).toBeUndefined()
  })
})

describe('hosted OAuth session establishment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A JWT-shaped credential (3 dot-separated segments) routes to the OAuth
  // /introspect branch. We stub global fetch so introspect returns the grant.
  function stubIntrospect(identity: Record<string, unknown>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(identity), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
  }

  async function initialize(port: number): Promise<{ status: number; body: string }> {
    return call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    }).then((r) => ({ status: r.status, body: r.body }))
  }

  it('establishes a session for an "all containers" grant (workspaceId only, no pinned container)', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTag: null, containerTags: [] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    // Would have been 400 "no valid workspace/container scope" before the fix.
    expect(result.status).toBe(200)
  })

  it('establishes a session for a multi-container grant without pinning', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTags: ['team:a', 'team:b'] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(200)
  })

  async function listTools(port: number): Promise<{ status: number; names: string[] }> {
    const result = await call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    // Stateless transport answers over SSE: pull the JSON-RPC payload out of the data: lines.
    const payloads = result.body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()) as { result?: { tools?: Array<{ name: string }> } })
    const names = payloads.flatMap((p) => (p.result?.tools ?? []).map((t) => t.name))
    return { status: result.status, names }
  }

  it('hides API-key-only personal tools from an OAuth session over the real transport', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTags: ['user:jane'] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await listTools(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(200)
    expect(result.names).toContain('memory_search')
    expect(result.names).toContain('memory_add')
    expect(result.names).toContain('memory_timeline')
    // 0.4.0 container-validated core tools stay visible to OAuth sessions...
    expect(result.names).toContain('memory_answer')
    expect(result.names).toContain('document_add')
    for (const hidden of [
      'daily_brief',
      'people_list',
      'people_get',
      'people_upsert',
      'reminder_create',
      'reminders_upcoming',
      'reminder_complete',
      'meeting_brief',
      'meetings_upcoming',
      'memory_merge',
      // ...but the bare-id routes (no container for the API to validate
      // against the grant's allowed set) are not listed to OAuth sessions.
      'memory_restore',
      'job_status',
    ]) expect(result.names, hidden).not.toContain(hidden)
  })

  it('refuses a direct tools/call to a gated tool from an OAuth session (listing is not authorization)', async () => {
    // Route-aware stub: introspect resolves the grant; any call that reaches
    // the jobs/restore routes is recorded — the gate must keep this at zero.
    const gatedRouteCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const href = String(url)
        if (href.includes('/v1/jobs/') || href.includes('/restore')) {
          gatedRouteCalls.push(href)
          return new Response(JSON.stringify({ id: 'job-999', status: 'completed' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({ tenantId: 'workspace', containerTags: ['user:jane'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const port = address.port

    async function callGated(name: string, args: Record<string, unknown>): Promise<string[]> {
      const result = await call(port, {
        method: 'POST',
        headers: {
          authorization: 'Bearer header.payload.signature',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      })
      return result.body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map(
          (line) =>
            JSON.parse(line.slice(5).trim()) as {
              result?: { isError?: boolean; content?: Array<{ text?: string }> }
            },
        )
        .flatMap((p) => (p.result?.isError ? (p.result.content ?? []).map((c) => c.text ?? '') : []))
    }

    const jobErrors = await callGated('job_status', { jobId: 'job-999' })
    const restoreErrors = await callGated('memory_restore', { id: '3f1d1e1c-0000-4000-8000-000000000000' })
    // oauth:false personal tools get the same call-path refusal (the API
    // would 403 them anyway; this proves the client never even asks).
    const mergeErrors = await callGated('memory_merge', {
      memoryIds: ['3f1d1e1c-0000-4000-8000-000000000001', '3f1d1e1c-0000-4000-8000-000000000002'],
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(jobErrors.join(' ')).toContain('not available to OAuth sessions')
    expect(restoreErrors.join(' ')).toContain('not available to OAuth sessions')
    expect(mergeErrors.join(' ')).toContain('not available to OAuth sessions')
    expect(gatedRouteCalls).toEqual([])
  })

  it('still rejects an OAuth grant with no workspace scope', async () => {
    stubIntrospect({ containerTags: [] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(400)
  })
})

describe('memory_search polarity over the real transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Route-aware fetch stub: introspect returns the grant, /v1/search records
  // its body and returns an empty result set.
  function stubApi(): { searchBodies: unknown[] } {
    const searchBodies: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url)
        if (href.includes('/v1/search')) {
          searchBodies.push(JSON.parse(String(init?.body)))
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          JSON.stringify({ tenantId: 'workspace', containerTags: ['user:jane'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    return { searchBodies }
  }

  async function callTool(
    port: number,
    args: Record<string, unknown>,
  ): Promise<{ status: number; errorMessages: string[] }> {
    const result = await call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: args },
      }),
    })
    const payloads = result.body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map(
        (line) =>
          JSON.parse(line.slice(5).trim()) as {
            result?: { isError?: boolean; content?: Array<{ text?: string }> }
          },
      )
    const errorMessages = payloads.flatMap((p) =>
      p.result?.isError ? (p.result.content ?? []).map((c) => c.text ?? '') : [],
    )
    return { status: result.status, errorMessages }
  }

  it('forwards a valid polarity through dispatch to /v1/search', async () => {
    const { searchBodies } = stubApi()
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    await callTool(address.port, { query: 'constraints', polarity: 'negative' })
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))

    expect(searchBodies).toHaveLength(1)
    expect(searchBodies[0]).toMatchObject({ q: 'constraints', polarity: 'negative' })
  })

  it('rejects an out-of-enum polarity at the MCP boundary without calling the API', async () => {
    const { searchBodies } = stubApi()
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await callTool(address.port, { query: 'constraints', polarity: 'bogus' })
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))

    expect(searchBodies).toHaveLength(0)
    expect(result.errorMessages.join(' ')).toMatch(/polarity/i)
  })
})

describe('OAuth identifiers (host move)', () => {
  const cutover = {
    MCP_RESOURCE_URL: 'https://mcp.getgaldo.com/mcp',
    MCP_AUTHORIZATION_SERVER: 'https://api.getgaldo.com/v1/mcp/oauth',
    MCP_LEGACY_RESOURCE_URLS: 'https://mcp.mnemohq.com/mcp',
  }

  it('defaults to the mnemohq identifiers when the env is unset', () => {
    expect(oauthIdentifiersFor('mcp.mnemohq.com', {})).toEqual({
      resource: 'https://mcp.mnemohq.com/mcp',
      authorizationServer: 'https://api.mnemohq.com/v1/mcp/oauth',
      resourceMetadataUrl: 'https://mcp.mnemohq.com/.well-known/oauth-protected-resource',
    })
  })

  it('advertises the primary resource on the primary host', () => {
    expect(oauthIdentifiersFor('mcp.getgaldo.com', cutover)).toEqual({
      resource: 'https://mcp.getgaldo.com/mcp',
      authorizationServer: 'https://api.getgaldo.com/v1/mcp/oauth',
      resourceMetadataUrl: 'https://mcp.getgaldo.com/.well-known/oauth-protected-resource',
    })
  })

  it('advertises a legacy resource only on its own host (case-insensitive)', () => {
    expect(oauthIdentifiersFor('MCP.mnemohq.com', cutover)).toEqual({
      resource: 'https://mcp.mnemohq.com/mcp',
      authorizationServer: 'https://api.getgaldo.com/v1/mcp/oauth',
      resourceMetadataUrl: 'https://mcp.mnemohq.com/.well-known/oauth-protected-resource',
    })
  })

  it.each([undefined, 'evil.example', 'mcp.mnemohq.com.evil.example', 'mcp.mnemohq.com:8443'])(
    'falls back to the primary for host %j',
    (host) => {
      expect(oauthIdentifiersFor(host, cutover).resource).toBe('https://mcp.getgaldo.com/mcp')
    },
  )

  it('ignores an unparseable legacy entry', () => {
    expect(oauthIdentifiersFor('mcp.mnemohq.com', { ...cutover, MCP_LEGACY_RESOURCE_URLS: 'not a url' }).resource)
      .toBe('https://mcp.getgaldo.com/mcp')
  })

  it('refuses to start with an unparseable MCP_RESOURCE_URL', () => {
    expect(() => createMcpHttpServer({ MCP_RESOURCE_URL: 'not a url' })).toThrow()
  })

  async function get(env: Record<string, string>, path: string, host: string) {
    const server = createMcpHttpServer({ GETMNEMO_CONTAINER_TAG: 'user:test', ...env })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const result = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path, method: path === '/mcp' ? 'POST' : 'GET', headers: { host } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    return result
  }

  it('serves protected-resource metadata per host', async () => {
    const primary = await get(cutover, '/.well-known/oauth-protected-resource', 'mcp.getgaldo.com')
    expect(JSON.parse(primary.body)).toEqual(expect.objectContaining({
      resource: 'https://mcp.getgaldo.com/mcp',
      authorization_servers: ['https://api.getgaldo.com/v1/mcp/oauth'],
    }))
    expect(primary.headers.vary).toBe('Host')
    const legacy = await get(cutover, '/.well-known/oauth-protected-resource', 'mcp.mnemohq.com')
    expect(JSON.parse(legacy.body).resource).toBe('https://mcp.mnemohq.com/mcp')
  })

  it('points the 401 challenge at the metadata for the host that was called', async () => {
    const result = await get(cutover, '/mcp', 'mcp.getgaldo.com')
    expect(result.status).toBe(401)
    expect(result.headers['www-authenticate']).toContain('resource_metadata="https://mcp.getgaldo.com/.well-known/oauth-protected-resource"')
  })
})

// The API restarting, overloaded or rate limiting must not take the MCP
// server down or make agents throw their tokens away: a failed or refused
// introspection is "try again shortly" (503), never a crash and never
// "invalid token" unless the API actually said so.
describe('introspection failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function healthz(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/healthz', method: 'GET' }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
  }

  async function withServer<T>(run: (port: number) => Promise<T>): Promise<T> {
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    try {
      return await run(address.port)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  }

  function toolCall(port: number) {
    return call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  }

  it.each([
    ['the API cannot be reached', () => Promise.reject(new TypeError('fetch failed'))],
    ['the introspection times out', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['the API is down (502)', async () => new Response('bad gateway', { status: 502 })],
    ['the API rate limits it (429)', async () => new Response('{"message":"Too many requests"}', { status: 429 })],
    ['the API answers something that is not JSON', async () => new Response('<html>', { status: 200 })],
  ])('answers 503 with Retry-After when %s, and keeps serving', async (_label, introspect) => {
    vi.stubGlobal('fetch', vi.fn(introspect))

    const [result, health] = await withServer(async (port) => [await toolCall(port), await healthz(port)] as const)

    expect(result.status).toBe(503)
    expect(result.headers['retry-after']).toBe('5')
    expect(result.headers['www-authenticate']).toBeUndefined()
    expect(health).toBe(200)
  })

  it('still answers 401 invalid_token when the API refuses the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Unauthorized"}', { status: 401 })))

    const result = await withServer((port) => toolCall(port))

    expect(result.status).toBe(401)
    expect(String(result.headers['www-authenticate'])).toContain('error="invalid_token"')
  })
})
