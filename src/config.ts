/**
 * Server-config helpers.
 *
 * SECURITY: the tenant boundary (container) is resolved here from
 * developer-supplied env/headers at server startup — it is the ONLY place
 * the container is set, and it is never surfaced as a model-fillable MCP
 * tool argument.
 */

import type { ContainerScope } from './api-client.js'

type EnvLike = Record<string, string | undefined>

/**
 * Resolve the configured tenant boundary from environment variables.
 * Prefers the simple `containerTag` string; falls back to structured scope.
 * Returns `null` when neither form is fully configured.
 */
export function resolveContainerFromEnv(env: EnvLike): ContainerScope | null {
  const tag = env.GETMNEMO_CONTAINER_TAG?.trim()
  if (tag) return { containerTag: tag }

  const scopeType = env.GETMNEMO_SCOPE_TYPE?.trim()
  const scopeId = env.GETMNEMO_SCOPE_ID?.trim()
  if (scopeType && scopeId) return { scope: { type: scopeType, id: scopeId } }

  return null
}

/**
 * Resolve the tenant boundary from a per-connection header bag (HTTP
 * transport), falling back to env. Still developer/operator-supplied at
 * connection time — never a model argument.
 */
export function resolveContainerFromHeaders(
  containerTagHeader: string | undefined,
  scopeTypeHeader: string | undefined,
  scopeIdHeader: string | undefined,
  env: EnvLike,
): ContainerScope | null {
  const tag = containerTagHeader?.trim()
  if (tag) return { containerTag: tag }

  const scopeType = scopeTypeHeader?.trim()
  const scopeId = scopeIdHeader?.trim()
  if (scopeType && scopeId) return { scope: { type: scopeType, id: scopeId } }

  return resolveContainerFromEnv(env)
}

/**
 * The most an answer-model call may be waited on: under Node fetch's 5
 * minutes (undici drops a response whose headers have not come by then)
 * and the self-hosted proxy's 300 s read timeout.
 */
export const MODEL_TIMEOUT_MAX_MS = 295_000

/** Waited on top of the API's own model budget, so the API's answer (or its 503) arrives before this side gives up. */
export const MODEL_TIMEOUT_GRACE_MS = 5_000

/**
 * How long a call that waits on the answer model (procedure_ask, the answer
 * tool) may take, from GETMNEMO_MODEL_TIMEOUT_MS: the API's own model
 * budget (a self-hosted install on a local CPU model sets it from
 * PROCEDURE_ASK_TIMEOUT_MS, 290000), plus a little grace, at most
 * MODEL_TIMEOUT_MAX_MS. Undefined when unset or unreadable: the hosted
 * defaults apply.
 */
export function modelTimeoutFromEnv(env: EnvLike): number | undefined {
  const raw = env.GETMNEMO_MODEL_TIMEOUT_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return Math.min(value + MODEL_TIMEOUT_GRACE_MS, MODEL_TIMEOUT_MAX_MS)
}
