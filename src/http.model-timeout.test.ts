import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from './server.js'
import { createMcpHttpServer } from './http.js'

// Spy on the per-session server factory, passing through to the real one.
vi.mock('./server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server.js')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

function listTools(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          authorization: 'Bearer header.payload.signature',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
}

async function sessionConfigFor(env: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ tenantId: 'workspace', containerTags: ['user:jane'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  )
  const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com', ...env })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  await listTools(address.port)
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  const calls = vi.mocked(createServer).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0]?.[0]
}

describe('GETMNEMO_MODEL_TIMEOUT_MS over HTTP', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(createServer).mockClear()
  })

  it('reaches every session\'s API client', async () => {
    await expect(sessionConfigFor({ GETMNEMO_MODEL_TIMEOUT_MS: '290000' })).resolves.toMatchObject({ modelTimeoutMs: 295_000 })
  })

  it('stays unset on hosted, so the default budgets apply', async () => {
    const cfg = await sessionConfigFor({})
    expect(cfg?.modelTimeoutMs).toBeUndefined()
  })
})
