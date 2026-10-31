#!/usr/bin/env node
/**
 * Stdio entry-point for local MCP clients (Claude Desktop, Cursor, Windsurf, Zed).
 *
 * Reads config from env (developer-supplied at server startup):
 *   GETMNEMO_API_URL       (default: https://api.mnemohq.com)
 *   GETMNEMO_API_KEY       (required)
 *   GETMNEMO_WORKSPACE_ID  (optional — derived from the key; set only to pin one)
 *   GETMNEMO_CONTAINER_TAG (the tenant boundary, e.g. "user:jane")
 *     — required UNLESS GETMNEMO_SCOPE_TYPE + GETMNEMO_SCOPE_ID are set.
 *   GETMNEMO_SCOPE_TYPE / GETMNEMO_SCOPE_ID (structured-scope alternative)
 *   GETMNEMO_MODEL_TIMEOUT_MS (optional — how long the API's answer model may take,
 *     in ms; a self-hosted local model on CPU needs minutes. Unset = hosted budgets)
 *
 * SECURITY: the container is the tenant boundary and is read ONLY from env
 * here — it is never exposed as a model-fillable MCP tool argument.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'
import { modelTimeoutFromEnv, resolveContainerFromEnv } from './config.js'

async function main(): Promise<void> {
  const apiKey = process.env.GETMNEMO_API_KEY
  // OPTIONAL since 0.3.1. The API derives the tenant from the key, so a
  // workspace id is an override for pinning an older deployment — not a
  // precondition. Requiring it made every integrator hunt for an id the
  // platform had already retired.
  const workspaceId = process.env.GETMNEMO_WORKSPACE_ID
  if (!apiKey) {
    process.stderr.write(
      'Mnemo MCP: GETMNEMO_API_KEY is not set.\n' +
        'Get a key at https://app.mnemohq.com/settings/api-keys\n',
    )
    process.exit(1)
  }

  const container = resolveContainerFromEnv(process.env)
  if (!container) {
    process.stderr.write(
      'Mnemo MCP: missing tenant boundary. Set GETMNEMO_CONTAINER_TAG (e.g. "user:jane")\n' +
        'or both GETMNEMO_SCOPE_TYPE and GETMNEMO_SCOPE_ID.\n',
    )
    process.exit(1)
  }

  const server = createServer({
    baseUrl: process.env.GETMNEMO_API_URL ?? 'https://api.mnemohq.com',
    apiKey,
    workspaceId,
    container,
    modelTimeoutMs: modelTimeoutFromEnv(process.env),
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Stays alive until parent process closes stdio.
}

main().catch((err) => {
  process.stderr.write(`Mnemo MCP fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
