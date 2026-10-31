# getmnemo-mcp

Model Context Protocol server for [Mnemo Memory](https://mnemohq.com) — exposes long-term memory tools to any MCP client (Claude Desktop, Cursor, Windsurf, VS Code, Zed).

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid 7-strategy retrieval over the workspace memory store. Filter by `polarity`, `searchMode` (memories/documents/both), exclude already-seen ids, or opt into `precise` mode. |
| `memory_answer` | Cited-answer pipeline: question in, synthesized answer + citations out (`mode: "fast"` for ~1-2s). |
| `memory_add` | Store an atomic fact with optional metadata; `polarity: "negative"` marks a hard constraint. |
| `memory_get` | Fetch one memory by ID within the configured container. |
| `memory_update` | Patch an existing memory's content, metadata, or polarity. |
| `memory_delete` | Soft-delete a memory by ID so it leaves retrieval. |
| `memory_restore` | Undo a soft delete during its recovery window (API-key sessions only). |
| `memory_list` | Paginate through memories (cursor-based). |
| `document_add` | Ingest a raw document (up to 500,000 characters) into the async extraction lane; returns a `jobId`. |
| `job_status` | Poll an ingestion job: queued / processing / completed / failed (API-key sessions only). |

### Personal-memory tools (0.3.0, Mnemo API v0.3.0)

| Tool | What it does | Key scope(s) | API flag |
|---|---|---|---|
| `daily_brief` | Today's reminders, important dates, last-24h captures, follow-ups and meetings for one container. | `brief:read` | `MEMORY_API_BRIEF_ENABLED` |
| `memory_timeline` | One container as a time-ordered stream of memories, reminders, documents (and optional events). | `timeline:read` | `MEMORY_API_TIMELINE_ENABLED` |
| `people_list` | People the workspace remembers, with memory / open-reminder counts. | `people:read` | `MEMORY_API_PEOPLE_ENABLED` |
| `people_get` | One person by slug (contact details, important dates, aliases). | `people:read` | `MEMORY_API_PEOPLE_ENABLED` |
| `people_upsert` | Create a person, or update them when the slug already exists. | `people:write` | `MEMORY_API_PEOPLE_ENABLED` |
| `reminder_create` | A reminder with a due time, filed under a person or a container. | `reminders:write` | `MEMORY_API_PEOPLE_ENABLED` |
| `reminders_upcoming` | Overdue / due-today / upcoming reminders plus important dates, by local day. | `reminders:read` | `MEMORY_API_PEOPLE_ENABLED` |
| `reminder_complete` | Mark a reminder done. | `reminders:write` | `MEMORY_API_PEOPLE_ENABLED` |
| `meetings_upcoming` | Upcoming Google Calendar meetings with attendees resolved to people. | `meetings:read` | `MEMORY_API_MEETINGS_ENABLED` |
| `meeting_brief` | Pre-meeting brief: reader answer with citations, matched people, previous meetings. | `meetings:read` + `answer:read` | `MEMORY_API_MEETINGS_ENABLED` |
| `memory_merge` | Fold 2..20 duplicate memories into one survivor (idempotent on `mergeKey`). | `memories:write` + `memories:delete` | `MEMORY_API_INBOX_ENABLED` |

These scopes are **opt-in**: mint (or edit) the API key with them at
<https://app.mnemohq.com/settings/api-keys>. Every feature is dark until the
API operator sets its `MEMORY_API_*` flag; until then the tool returns a
`503 FEATURE_DISABLED` error that names the flag.

All personal-memory tools except `memory_timeline` are **API-key only**:
the API rejects hosted OAuth MCP tokens on cross-container routes, so hosted
OAuth sessions (`https://mcp.mnemohq.com/mcp`) do not list them.

### Procedure tools

How the team does things, learned from their captured browser work. Read
only, published procedures only, and the same for every caller.

| Tool | What it does | Scope |
|---|---|---|
| `procedure_list` | The workspace's published procedures, most recently seen first, optionally for one app. | `memories:read` |
| `procedure_get` | One procedure's current steps and conditions, plus its version history. | `memories:read` |
| `procedure_ask` | "How do we do X here?", answered from published procedures with citations. `abstained: true` means none covers it. | `search:read` |

On a self-hosted install with a local model, `procedure_ask` and
`memory_answer` can take minutes. Set `GETMNEMO_MODEL_TIMEOUT_MS` to how long
the API's model may take per call (on a local model, the API's
`PROCEDURE_ASK_TIMEOUT_MS`, 290000). `procedure_ask` then waits that plus 5 s
and `memory_answer` at least that plus 5 s, at most 295 s. Unset, they keep
the 30 s and 90 s defaults. Your MCP client has its own per-call timeout
(often 60 s): raise it too, or it gives up first.

Hosted OAuth sessions get all three. A connection limited to some containers
reaches them only when its grant includes `procedures:workspace`.

Remote HTTP calls are scoped by the user's Mnemo OAuth grant. The user signs
in, chooses a workspace and memory container, and the server derives that
scope from the access token. The model cannot set or change it.

## Install

### Local stdio clients

```bash
npx -y getmnemo-mcp
```

Or wire it into the client config directly. Example for Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "getmnemo": {
      "command": "npx",
      "args": ["-y", "getmnemo-mcp"],
      "env": {
        "GETMNEMO_API_KEY": "prfly_live_...",
        "GETMNEMO_WORKSPACE_ID": "ws_...",
        "GETMNEMO_CONTAINER_TAG": "user:jane"
      }
    }
  }
}
```

Get an API key at <https://app.mnemohq.com/settings/api-keys>.

### Hosted remote MCP clients

For clients that support remote MCP and OAuth 2.1, use:

```text
https://mcp.mnemohq.com/mcp
```

The client should discover OAuth metadata, open Mnemo sign-in, and return to
the client after the user selects a workspace and container. No API key,
workspace header, or container configuration is required for this path.

## Develop

```bash
npm install
cp .env.example .env   # fill in API-key/container values for stdio
npm run dev            # stdio
npm run dev:http       # Streamable HTTP on :8787
npm run build          # bundle to dist/
npm run lint && npm run typecheck && npm test
```

## Architecture

- **stdio** (`src/cli.ts`): one process per MCP client connection, env-configured.
- **Streamable HTTP** (`src/http.ts`): hosted transport for public OAuth sessions, with private API-key compatibility for trusted deployments.
- Both transports share `src/server.ts` (tool registration + dispatch), `src/personal-tools.ts` (personal-memory tools) and `src/api-client.ts` (typed REST wrapper).

The public hosted transport uses Mnemo's OAuth 2.1 authorization server and
resource-bound tokens. Header-selected containers remain disabled by default;
they are only a private compatibility path for a trusted gateway.

The server deliberately does NOT depend on `getmnemo` (the JS SDK) so it can ship independently.

## License

MIT
