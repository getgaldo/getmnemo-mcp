import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createServer } from './server.js'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function apiError(status: number, code: string | undefined, message: string): Response {
  return response({ statusCode: status, error: 'Error', ...(code ? { code } : {}), message }, status)
}

type Harness = {
  client: Client
  fetchImpl: FetchMock
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
  close: () => Promise<void>
}

async function harness(
  fetchImpl: FetchMock,
  options: { container?: { containerTag: string }; principal?: 'api_key' | 'oauth' } = { container: { containerTag: 'user:jane' } },
): Promise<Harness> {
  const server = createServer(
    {
      baseUrl: 'https://api.example.com',
      apiKey: 'mnemo_live_test',
      workspaceId: 'workspace',
      ...(options.container ? { container: options.container } : {}),
      fetch: fetchImpl,
    },
    options.principal ? { principal: options.principal } : undefined,
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    fetchImpl,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as Array<{ type: string; text?: string }>
      return { text: content[0]?.text ?? '', isError: result.isError === true }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

const PROCEDURE = '33333333-3333-4333-8333-333333333333'

describe('procedure tools', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  it('are listed for API-key and OAuth sessions alike', async () => {
    for (const principal of ['api_key', 'oauth'] as const) {
      h = await harness(vi.fn<typeof fetch>(), { principal })
      const { tools } = await h.client.listTools()
      const names = tools.map((t) => t.name)
      for (const tool of ['procedure_list', 'procedure_get', 'procedure_ask']) expect(names, `${principal} ${tool}`).toContain(tool)
      await h.close()
      h = undefined
    }
  })

  it('procedure_list sends app, limit and cursor as query params and no container header', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null }))
    h = await harness(fetchImpl, { principal: 'oauth' })
    const { text, isError } = await h.call('procedure_list', { app: 'acme.zendesk.com', limit: 5, cursor: 'abc' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({ items: [], nextCursor: null })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/procedures?app=acme.zendesk.com&limit=5&cursor=abc')
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).has('x-mnemo-container')).toBe(false)
  })

  it('procedure_list defaults the page to 25 and rejects an app that is not a host name', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null }))
    h = await harness(fetchImpl)
    await h.call('procedure_list', {})
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/procedures?limit=25')
    const bad = await h.call('procedure_list', { app: 'Acme Zendesk' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('Invalid arguments: app')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('procedure_get reads one procedure by id and refuses a non-UUID before calling the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: PROCEDURE, title: 'Process a return' }))
    h = await harness(fetchImpl)
    const ok = await h.call('procedure_get', { id: PROCEDURE })
    expect(JSON.parse(ok.text)).toEqual({ id: PROCEDURE, title: 'Process a return' })
    expect(fetchImpl.mock.calls[0]![0]).toBe(`https://api.example.com/v1/procedures/${PROCEDURE}`)
    const bad = await h.call('procedure_get', { id: '../memories' })
    expect(bad.isError).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('procedure_get says plainly when no published procedure has the id', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(404, undefined, 'Procedure not found')))
    const { text, isError } = await h.call('procedure_get', { id: PROCEDURE })
    expect(isError).toBe(true)
    expect(text).toBe('No published procedure with that id.')
  })

  it('procedure_ask posts the question and returns the answer with abstained and citations', async () => {
    const answer = { answer: 'Open the ticket, then refund.', abstained: false, citations: [] }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(answer))
    h = await harness(fetchImpl, { principal: 'oauth' })
    const { text, isError } = await h.call('procedure_ask', { q: 'How do we process a return?' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual(answer)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.example.com/v1/procedures/ask')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ q: 'How do we process a return?' })
  })

  it('procedure_ask refuses a blank or over-long question before calling the API', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    h = await harness(fetchImpl)
    expect((await h.call('procedure_ask', { q: '   ' })).isError).toBe(true)
    expect((await h.call('procedure_ask', { q: 'x'.repeat(501) })).isError).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes a 404 on procedure_list through instead of claiming no such procedure', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(404, undefined, 'Cannot GET /v1/procedures')))
    const { text, isError } = await h.call('procedure_list', {})
    expect(isError).toBe(true)
    expect(text).toBe('Mnemo API error (404): Cannot GET /v1/procedures')
  })

  it("passes the API's own refusal through, which names the procedures container", async () => {
    const message = 'This connection does not cover the procedures container (procedures:workspace).'
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(403, 'PROCEDURES_OUTSIDE_GRANT', message)), { principal: 'oauth' })
    const { text, isError } = await h.call('procedure_list', {})
    expect(isError).toBe(true)
    expect(text).toBe(`Mnemo API error (403): ${message}`)
  })
})
