import { afterEach, describe, expect, it, vi } from 'vitest'
import { MnemoApiClient } from './api-client.js'
import { MODEL_TIMEOUT_MAX_MS, modelTimeoutFromEnv } from './config.js'

// A self-hosted install on its bundled local model (CPU) answers a question in
// one to three minutes. procedure_ask waited 30 s and the answer tool 90 s, so
// on such an install every question failed as an abort.

/** A fetch that answers only when told to, and rejects as fetch does when its signal aborts. */
function slowFetch() {
  let answer: (body: unknown) => void = () => undefined
  let aborted = false
  const fetchImpl = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        answer = (body) => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), (aborted = true)))
      }),
  )
  return { fetchImpl, answer: (body: unknown) => answer(body), aborted: () => aborted }
}

function client(fetchImpl: typeof fetch, modelTimeoutMs?: number): MnemoApiClient {
  return new MnemoApiClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'mnemo_live_test',
    container: { containerTag: 'user:test' },
    fetch: fetchImpl,
    ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : {}),
  })
}

const ANSWER = { answer: 'Open the ticket, then submit it as solved.', abstained: false, citations: [] }

describe('GETMNEMO_MODEL_TIMEOUT_MS', () => {
  it('is unset, and the hosted budgets apply, when missing or unreadable', () => {
    for (const raw of [undefined, '', '  ', 'abc', '-5', '0', '1.5', '12ms']) {
      expect(modelTimeoutFromEnv({ GETMNEMO_MODEL_TIMEOUT_MS: raw })).toBeUndefined()
    }
  })

  it('waits the API\'s model budget plus a little, so the API\'s own answer or 503 arrives first', () => {
    expect(modelTimeoutFromEnv({ GETMNEMO_MODEL_TIMEOUT_MS: '120000' })).toBe(125_000)
    // What a self-hosted install on the local model sets (PROCEDURE_ASK_TIMEOUT_MS).
    expect(modelTimeoutFromEnv({ GETMNEMO_MODEL_TIMEOUT_MS: '290000' })).toBe(MODEL_TIMEOUT_MAX_MS)
  })

  it('never waits past 295 s: Node fetch and the proxy give up at 300 s', () => {
    expect(MODEL_TIMEOUT_MAX_MS).toBe(295_000)
    expect(modelTimeoutFromEnv({ GETMNEMO_MODEL_TIMEOUT_MS: '900000' })).toBe(MODEL_TIMEOUT_MAX_MS)
  })
})

describe('calls that wait on the answer model', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('procedure_ask keeps the 30 s request budget when no model budget is set', async () => {
    vi.useFakeTimers()
    const slow = slowFetch()
    const pending = client(slow.fetchImpl).askProcedures('How do we process a wholesale return?').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(slow.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toBeInstanceOf(Error)
  })

  it('procedure_ask waits for a local model\'s answer past 30 s, up to the model budget', async () => {
    vi.useFakeTimers()
    const slow = slowFetch()
    const pending = client(slow.fetchImpl, 295_000).askProcedures('How do we process a wholesale return?')
    // 166 s: the first question on the reference install's 2 cores.
    await vi.advanceTimersByTimeAsync(166_000)
    slow.answer(ANSWER)
    await expect(pending).resolves.toEqual(ANSWER)

    const stuck = slowFetch()
    const late = client(stuck.fetchImpl, 295_000).askProcedures('q').catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(294_999)
    expect(stuck.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await late).toBeInstanceOf(Error)
  })

  it('the answer tool waits the longer of its own 90 s and the model budget', async () => {
    vi.useFakeTimers()
    const slow = slowFetch()
    const pending = client(slow.fetchImpl, 295_000).answerQuestion({ question: 'Who approves big refunds?' })
    await vi.advanceTimersByTimeAsync(200_000)
    slow.answer(ANSWER)
    await expect(pending).resolves.toEqual(ANSWER)

    const hosted = slowFetch()
    const failed = client(hosted.fetchImpl).answerQuestion({ question: 'q' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(89_999)
    expect(hosted.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await failed).toBeInstanceOf(Error)
  })

  it('other calls keep the 30 s request budget whatever the model budget', async () => {
    vi.useFakeTimers()
    const slow = slowFetch()
    const pending = client(slow.fetchImpl, 295_000).search({ query: 'refunds' }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(slow.aborted()).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toBeInstanceOf(Error)
  })
})
