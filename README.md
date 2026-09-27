# Kstonebase MCP — Specs as the Source of Truth for AI Coding Agents

Kstonebase is the home for product, feature, and architectural specs. The Kstonebase MCP server gives local AI coding agents (Claude Code, Cursor, VS Code, Zed, Windsurf, …) **read and write access to those specs**, so agents can plan, implement, and update features against the spec — not against stale `docs/`, hallucinated APIs, or whatever the model remembers from training.

## ❌ Without Kstonebase MCP

Coding agents drift from your product's actual contracts. You get:

- ❌ Code that ships ahead of the spec, then quietly diverges
- ❌ Implementations that contradict ADRs nobody re-read
- ❌ Duplicate "RFC-2025-…" markdown files in the repo, none authoritative
- ❌ Specs updated only after the code lands, when nobody can challenge them

## ✅ With Kstonebase MCP

The agent reads the **current** spec before writing code, and proposes spec changes through the same workflow a human reviewer approves.

```
Implement the password-reset flow per the "auth/password-reset" spec.
Use the contracts and error codes from §4. If the spec is incomplete,
open a draft, fill it in, and request review before writing code.
```

```
What ADRs apply to background jobs in this product? Read them, then
critique my proposed worker change against them.
```

The agent calls `read_specification`, `list_open_questions`, `start_new_version`, `update_specification_section`, `request_review` — and you stay in control: **a human still marks the draft Reviewed in the Kstonebase UI**.

## 📚 Concepts

- **Workspace** — top-level container. Contains member Products plus its own Workspace-scoped specs (e.g., cross-product ADRs).
- **Product** — a single product or service. Holds the feature, UX, and architecture specs that govern its codebase.
- **Specification** — Markdown document with status (`Draft` → `Needs Review` → `Reviewed`), open questions, and a version history.
- **Binding** — a `.kstonebase.json` at the repo root binds the local checkout to a Workspace and/or Product, so agents don't have to pass ids on every call.

See `kstonebase.com` for the dashboard and to mint a token.

## 🛠️ Installation

### Requirements

- **Node.js ≥ 20.11**
- An MCP-compatible client (Claude Code, Cursor, VS Code, Windsurf, Zed, Claude Desktop, …)
- An **Kstonebase Personal Access Token** — generate one at `https://kstonebase.com/settings/developer`
- A repo with a `.kstonebase.json` file (or `KSTONEBASE_WORKSPACE_ID` / `KSTONEBASE_PRODUCT_ID` env vars). See [Binding the workspace](#binding-the-workspace) below.

### **Install in Claude Code**

Run this command. See the [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp) for more info.

```bash
claude mcp add --scope user \
  -e KSTONEBASE_API_TOKEN=YOUR_TOKEN \
  kstonebase -- npx -y @ravitecnologia/kstonebase-mcp
```

Drop `--scope user` to install only for the current project.

To add a rule so the agent always reads the spec first, append the snippet from [Add a rule](#add-a-rule) below to your `CLAUDE.md`.

### **Install in Cursor**

Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). See the [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol).

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "npx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": {
        "KSTONEBASE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### **Install in VS Code**

See the [VS Code MCP docs](https://code.visualstudio.com/docs/copilot/chat/mcp-servers).

```json
"mcp": {
  "servers": {
    "kstonebase": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": {
        "KSTONEBASE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### **Install in Windsurf**

Add this to your Windsurf MCP config. See the [Windsurf MCP docs](https://docs.windsurf.com/windsurf/cascade/mcp).

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "npx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": {
        "KSTONEBASE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### **Install in Zed**

Add this to your Zed `settings.json`. See the [Zed Context Server docs](https://zed.dev/docs/assistant/context-servers).

```json
{
  "context_servers": {
    "Kstonebase": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": {
        "KSTONEBASE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### **Install in Claude Desktop**

Edit your `claude_desktop_config.json`. See the [Claude Desktop MCP docs](https://modelcontextprotocol.io/quickstart/user).

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "npx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": {
        "KSTONEBASE_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### **Install in OpenAI Codex**

See the [OpenAI Codex repo](https://github.com/openai/codex) for more on the MCP configuration format. Codex reads `~/.codex/config.toml`.

#### Codex Local Server Connection (stdio)

```toml
[mcp_servers.kstonebase]
command = "npx"
args = ["-y", "@ravitecnologia/kstonebase-mcp"]
env = { KSTONEBASE_API_TOKEN = "YOUR_TOKEN" }
startup_timeout_ms = 20_000
```

#### Codex Remote Server Connection (HTTP)

First, run the server (see [Running over HTTP](#running-over-http-hosted-agents)). Then point Codex at it:

```toml
[mcp_servers.kstonebase]
url = "http://127.0.0.1:3030/mcp"
http_headers = { "Authorization" = "Bearer YOUR_TOKEN" }
```

> Optional troubleshooting — only if Codex reports startup "request timed out" or "program not found". Most users can ignore this.
>
> - First try: bump `startup_timeout_ms` to `40_000`.
> - **Windows** quick fix (absolute `npx` path + explicit env):
>
>   ```toml
>   [mcp_servers.kstonebase]
>   command = "C:\\Users\\yourname\\AppData\\Roaming\\npm\\npx.cmd"
>   args = ["-y", "@ravitecnologia/kstonebase-mcp"]
>   env = {
>     KSTONEBASE_API_TOKEN = "YOUR_TOKEN",
>     SystemRoot = "C:\\Windows",
>     APPDATA = "C:\\Users\\yourname\\AppData\\Roaming"
>   }
>   startup_timeout_ms = 40_000
>   ```
>
> - **macOS** quick fix (call Node directly with the installed package's entry point):
>
>   ```toml
>   [mcp_servers.kstonebase]
>   command = "/Users/yourname/.nvm/versions/node/v22.14.0/bin/node"
>   args = [
>     "/Users/yourname/.nvm/versions/node/v22.14.0/lib/node_modules/@ravitecnologia/kstonebase-mcp/dist/cli.js",
>     "--stdio"
>   ]
>   env = { KSTONEBASE_API_TOKEN = "YOUR_TOKEN" }
>   ```
>
> Replace `yourname` with your OS username. On Windows, setting `APPDATA` and `SystemRoot` is essential because `npx` requires them but some Codex builds don't pass them through.

### **Using Bun or Deno**

Any client that launches an MCP server via `command + args` can swap `npx` for an alternative runtime.

#### Bun

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "bunx",
      "args": ["-y", "@ravitecnologia/kstonebase-mcp"],
      "env": { "KSTONEBASE_API_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

#### Deno

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "deno",
      "args": [
        "run",
        "--allow-env",
        "--allow-net",
        "--allow-read",
        "npm:@ravitecnologia/kstonebase-mcp"
      ],
      "env": { "KSTONEBASE_API_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

### **Install in Windows**

`npx` on Windows usually needs to be invoked via `cmd /c`:

```json
{
  "mcpServers": {
    "kstonebase": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@ravitecnologia/kstonebase-mcp"],
      "env": { "KSTONEBASE_API_TOKEN": "YOUR_TOKEN" }
    }
  }
}
```

### Running over HTTP (hosted agents)

For agents that consume MCP over HTTP/SSE rather than stdio, run the server explicitly:

```bash
KSTONEBASE_API_TOKEN=YOUR_TOKEN \
  npx -y @ravitecnologia/kstonebase-mcp --http --port 3030 --cors-origin https://your-agent.example.com
```

Then point your hosted agent at `http://<host>:3030/mcp`.

## 🔗 Binding the workspace

The MCP server is **bound** to a Workspace and/or a Product so tools like `list_specifications` work without passing ids every call.

Drop a `.kstonebase.json` at your repo root:

```json
{
  "workspaceId": "ws_…",
  "productId": "prd_…"
}
```

Either field is optional:

| Configuration               | Effective mode      | What works                                                                |
| --------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `workspaceId` + `productId` | `workspace+product` | Everything; defaults to the Product's specs                               |
| `workspaceId` only          | `workspace`         | Workspace-scoped specs + cross-Product search                             |
| `productId` only            | `product`           | Product-scoped specs (orphan / pre-aggregation Products work this way)    |
| Neither                     | `discovery`         | Only `list_workspaces` / `list_products` — bind first to do anything else |

You can also use environment variables: `KSTONEBASE_WORKSPACE_ID`, `KSTONEBASE_PRODUCT_ID`. The file wins over env vars when both are present.

## ✅ Verify the install

```bash
KSTONEBASE_API_TOKEN=YOUR_TOKEN npx -y @ravitecnologia/kstonebase-mcp --check
```

Prints `OK: https://kstonebase.com reachable, N product(s) visible.` on success, or a structured error code (`AUTH_REQUIRED`, `PRODUCT_NOT_BOUND`, …) and remediation when something is off. Add `--json` for machine-readable output.

## 🔨 Available Tools

All tools take ids as strings. Bound Workspace/Product ids are inferred from `.kstonebase.json` unless overridden in the call.

### Read tools

| Tool                          | Purpose                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_workspaces`             | List Workspaces visible to the token. Use when you don't yet know which Workspace to bind.                                                                                             |
| `list_products`               | List Products. With a Workspace binding, returns its member Products; without, returns orphan Products.                                                                                |
| `read_workspace`              | Workspace metadata: name, description, type, archived state.                                                                                                                           |
| `read_product`                | Product metadata: name, description, `specificationManagementType`, member-of Workspace.                                                                                               |
| `list_specifications`         | List specs in scope. Filters: `type` (BUSINESS / UX / DESIGN_SYSTEM / DOCUMENT), `status` (DRAFT / GENERATING / NEEDS_REVIEW / REVIEWED), `folder`, `tags`, `query`. Cursor-paginated. |
| `search_specifications`       | Lexical full-text search across spec titles and content. Workspace bindings search the Workspace plus every member Product; results carry a `scope` discriminator.                     |
| `read_specification`          | Current Markdown body of a spec, plus status and OCC `version`. Use `format="rendered"` to strip open-question and assumption markers.                                                 |
| `list_specification_versions` | Reviewed snapshots of a spec, newest first.                                                                                                                                            |
| `read_specification_version`  | Full Markdown of a specific approved revision. Pair with `list_specification_versions` to diff history against current.                                                                |
| `list_specification_changes`  | Decisions and fixes recorded against a spec, newest first. These live outside the document, so the spec body stays consolidated — read them to recover the "why".                      |
| `read_specification_change`   | Full Markdown of one change entry. Pair with `list_specification_changes`.                                                                                                             |
| `list_open_questions`         | Questions and assumptions attached to a spec. Resolved/dismissed items are excluded unless `includeResolved=true`. Newer deployments also return the spec's current `version`.        |
| `read_open_question`          | One question or assumption plus the spec's current `version`. Its `updatedAt` is the `expectedUpdatedAt` that updates and deletes need. See [Open questions and assumptions](#open-questions-and-assumptions). |

### Write tools

| Tool                           | Purpose                                                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_new_version`            | Open a new Draft of a Reviewed spec. Required before any write tool on a published spec. No-op when the spec is already a Draft (returns `hint="already_draft"`).                                        |
| `update_specification_content` | Replace the full Markdown body of a Draft. OCC-guarded — pass the `version` from your most recent `read_specification`. Returns `STALE_VERSION` (409) if another writer landed first; re-read and retry. |
| `update_specification_section` | Replace one heading-bound section (`sectionPath="## Pricing"`). OCC-guarded. Records a before-image revision. Pass `changeNote` to say why — it is stored as a change entry, not in the document.        |
| `append_context`               | Record a decision or note **against** a spec as an immutable change entry. Does not modify the document, so it works on any non-archived spec and needs no `start_new_version`.                          |
| `request_review`               | Move a Draft to `Needs Review` for a human to approve. Open questions do not block it; they stay open for the reviewer (older servers may still answer `OPEN_QUESTIONS_PRESENT`).                     |
| `discard_draft`                | Roll a Draft (or Needs Review) back to its last approved version. Rejected on specs that have never been approved.                                                                                       |
| `create_free_specification`    | Create a new Markdown spec in the bound Free product. Path uniqueness is enforced. Rejected with `PRODUCT_TYPE_MISMATCH` on Web Application Products — use `start_new_version` on a structured spec.     |
| `create_open_question`         | Add a question (default) or an assumption to a Draft, together with its inline marker. Needs the spec `version`.                                                                                          |
| `update_open_question`         | Edit, move, resolve, dismiss or reopen a question or assumption; the document text changes with it. Answering a question also works on a spec in Needs Review or Reviewed and moves it to Draft. Needs `version` and `expectedUpdatedAt`. |
| `delete_open_question`         | **Permanently** delete a question or assumption and any marker still in the document. Needs `version` and `expectedUpdatedAt`. To set an item aside, dismiss it instead.                                   |

> **Note** — the agent never calls "mark reviewed". Approval stays a human action in the Kstonebase UI. The MCP can only nudge a draft to `Needs Review`.

### Open questions and assumptions

`list_open_questions`, `read_open_question`, `create_open_question`, `update_open_question` and `delete_open_question` manage the questions and assumptions of one specification. The Kstonebase API changes the record and its inline Markdown marker together, in one transaction, so the question list and the document never disagree.

- **Scope** — every call names the specification (`specId`, plus `questionId` for a single item); the `.kstonebase.json` binding is not used. Product specifications (Free and Web Application) and Workspace specifications work the same way. The token needs access to that specification, and the `write` scope for changes.
- **Draft only, except answers** — create, update and delete need a non-archived Draft. A Reviewed spec needs `start_new_version` first. A spec in Needs Review must be moved back to Draft by a human in Kstonebase — `start_new_version` does not unlock it. A generating spec must finish first. These tools never change `approvedVersion` or human approval.
- **Answering after review** — answering an `OPEN` question (`status: "RESOLVED"` with its `answer`, and no `body` or `sectionPath`) is the one change that also works on a spec in Needs Review or Reviewed. In the same change the spec moves to Draft: a Needs Review spec goes back to Draft at the same version, a Reviewed spec gets a new draft with the answer (its approved version stays published until a human approves the next one). Do not call `start_new_version` first; the response's `spec.status` is `DRAFT`. Every other change on those specs still fails with `SPEC_LOCKED`.
- **Two concurrency tokens** — every change needs `version`, the spec's current version (from `read_specification`, `list_open_questions` or `read_open_question`). Updates and deletes also need `expectedUpdatedAt`: the item's `updatedAt`, copied exactly as returned. Each successful change returns the new `spec.version` and `question.updatedAt` for the next call. After `STALE_VERSION` or `STALE_QUESTION`, re-read and decide again. The server never retries a change; after a timeout, re-read before retrying, because the change may already have been applied.

| Action | Record | Document text |
| --- | --- | --- |
| Create a question | New `OPEN` item | `<open_question>BODY</open_question>` at the end of the `sectionPath` section's own text (before any sub-heading), or at the end of the document when `sectionPath` is omitted |
| Create an assumption | New `OPEN` item | `_Assumption: BODY_`, placed the same way (the body cannot contain `_` or line breaks) |
| Edit or move (`OPEN` items only) | `body` and/or section updated | The marker changes or moves with the record; `sectionPath: null` moves it to the end of the document. Saving a draft `answer` alone never touches the text. |
| Resolve a question | `RESOLVED`, `resolvedAt` set | The marker is replaced by the answer. A non-blank answer is required, passed now or saved earlier. |
| Dismiss a question | `DISMISSED` | Unchanged: the marker stays |
| Resolve an assumption | `RESOLVED`, `resolvedAt` set | The marker becomes the body as plain prose |
| Dismiss an assumption | `DISMISSED` | The marker becomes `~~BODY~~ (not a valid assumption)` |
| Reopen (`status: "OPEN"` alone) | `OPEN`; answer and `resolvedAt` cleared | An unresolved marker comes back; prose written by the earlier decision stays |
| Delete | Removed permanently | Any marker still in the document is removed; prose written by an earlier resolution or dismissal stays |

**Resolve, dismiss or delete?** Resolve when a question has its answer or an assumption holds. Dismiss when the item no longer applies: it stays on record and can be reopened. Delete only items created by mistake — deletion cannot be undone.

A `RESOLVED` or `DISMISSED` item must be reopened (`status: "OPEN"` on its own) before its body, section or answer can change, or before it can move to the other final status. `body` and `sectionPath` cannot be combined with a status change, and `answer` applies to questions only. Repeating an item's current final status is a no-op.

Failures to expect: `STALE_VERSION`, `STALE_QUESTION`, `MARKER_NOT_FOUND` (the marker was edited away — restore it or delete the item), `MARKER_AMBIGUOUS` (identical markers, or the same text already in that section), `SECTION_AMBIGUOUS`, `ANSWER_REQUIRED`, `INVALID_TRANSITION`, `SPEC_LOCKED`, `SPEC_ARCHIVED`, `TOKEN_SCOPE_MISMATCH` (also for a token without the `write` scope; the message names the exact reason), `VALIDATION_ERROR` and `NOT_FOUND`. `NOT_FOUND` also covers a `sectionPath` that matches no heading (`details.sectionPath`) and a reopen whose recorded heading no longer exists (`details.reason` is `ANCHOR_STALE`). Each failure carries a remediation plus the API's `details` (`hint`, `reason`, `fields`, `status`, `sectionPath`, `from`, `to`). A failed change changes nothing.

> **Backend prerequisite** — these tools need a Kstonebase deployment whose API serves the open-question routes and whose Website proxies them under `/api/mcp/specifications/:specId/open-questions` (GET, POST) and `/api/mcp/specifications/:specId/open-questions/:questionId` (GET, PATCH, and DELETE with a JSON body). Against an older deployment, `read_open_question`, `create_open_question`, `update_open_question` and `delete_open_question` fail (typically `NOT_FOUND` or `INTERNAL_ERROR` from an HTTP 404 or 405), while `list_open_questions` keeps working without the `spec` metadata.

### Setup tools

These plan the local binding files (`.kstonebase.json`, `CLAUDE.md`, `AGENTS.md`). They never write to disk themselves — they return a structured file plan the agent applies with its own file-write tool, and existing files come back as `action="skip"` so the tools are safe to re-run.

| Tool             | Purpose                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `init_workspace` | Bind this directory to a Workspace. Pass `workspaceId`, or omit it to get `status="needs_selection"` with the candidate Workspaces — present them to the user, then call again with the chosen id.                                                                        |
| `init_product`   | Bind this directory to a Product (and its parent Workspace when known). Pass `productId`, or omit it to get `status="needs_selection"` with the candidate Products (optionally pass a `workspaceId` to scope the list), then call again with the chosen id.               |

Pass `existingFiles` + `existingKstonebaseJson` (the agent reads them) so the plan can mark files `skip` / `conflict`; `force=true` overwrites. `includeAgentDocs=false` plans only `.kstonebase.json`.

## 🛟 Tips

### Add a rule

Once installed, tell your agent to consult Kstonebase before writing code. Drop this into `CLAUDE.md`, `.cursorrules`, `.windsurfrules`, or your client's equivalent:

```
Before writing or updating code, planning a feature, or making an architectural
choice, search and read the relevant Kstonebase specs via the kstonebase
MCP. Treat them as the source of truth. If a spec is wrong or incomplete, open
a draft (start_new_version), update it (update_specification_section), and
request review (request_review) before implementing. Never duplicate spec
content into the repo.
```

The repo's `CLAUDE.md` is a good place for project-specific guidance.

### Use ids when you have them

If you already know the spec id, pass it directly to skip the search:

```
Read the "auth/password-reset" spec and reconcile §4 with the current
src/server/auth/reset.ts implementation. specId=spec_01H…
```

### Self-hosted / dev API

Override the API base URL at the binding:

```json
{
  "apiUrl": "http://localhost:3000",
  "workspaceId": "ws_local_dev",
  "productId": "prd_local_dev"
}
```

`http://localhost` is allowed without `--allow-insecure`. For any other non-HTTPS host, pass `--allow-insecure` (intended for self-hosted dev only).

### HTTPS proxy

Standard `https_proxy` / `HTTPS_PROXY` env vars are honoured.

## 💻 Development

```bash
# From the monorepo root
npm install
npm run build
npx vitest run   # tests
```

Run the built server:

```bash
KSTONEBASE_API_TOKEN=YOUR_TOKEN node dist/cli.js
```

### CLI Arguments

`kstonebase-mcp` accepts:

- `serve` _(default)_ — run the MCP server. Stdio unless `--http` is set.
- `--check` — verify token + API URL and exit `0`/`1`. Pair with `--json` for scripting.
- `--help`, `-h` — usage.
- `--stdio` — run over stdio (default; for desktop agents).
- `--http` — run as an HTTP/SSE server (for hosted agents).
- `--port <n>` — port for `--http` (default `3030`).
- `--host <addr>` — host for `--http` (default `127.0.0.1`).
- `--cors-origin <o>` — origin to allow (repeatable). Without this, cross-origin browser requests are rejected.
- `--api-url <url>` — override the Kstonebase API base URL.
- `--allow-insecure` — permit a non-HTTPS `apiUrl` (self-hosted dev only).

### Environment Variables

| Variable            | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| `KSTONEBASE_API_TOKEN`    | **Required.** Personal Access Token from `/settings/developer`. |
| `KSTONEBASE_API_URL`      | Override the API base URL. Default `https://kstonebase.com`.          |
| `KSTONEBASE_WORKSPACE_ID` | Default Workspace binding when no `.kstonebase.json` is present.      |
| `KSTONEBASE_PRODUCT_ID`   | Default Product binding when no `.kstonebase.json` is present.        |
| `KSTONEBASE_TELEMETRY`    | Set to `0` to disable anonymous telemetry.                      |
| `KSTONEBASE_LOG_LEVEL`    | `debug` \| `info` \| `warn` \| `error` (default `info`).        |

The `--api-url` CLI flag takes precedence over `KSTONEBASE_API_URL`. The `.kstonebase.json` `apiUrl` field falls between the two.

### Testing with MCP Inspector

```bash
KSTONEBASE_API_TOKEN=YOUR_TOKEN \
  npx -y @modelcontextprotocol/inspector npx @ravitecnologia/kstonebase-mcp
```

## 🚨 Troubleshooting

**`AUTH_REQUIRED` / 401 from every tool** — token is missing, expired, or revoked. Mint a new one at `/settings/developer` and update your client's `env`.

**`PRODUCT_NOT_BOUND` / `WORKSPACE_NOT_BOUND`** — the tool needs a binding the session doesn't have. Either pass `productId` / `workspaceId` explicitly, or add it to `.kstonebase.json` (see [Binding the workspace](#binding-the-workspace)).

**`STALE_VERSION` from `update_specification_*`** — another writer landed between your read and your write. Re-call `read_specification` to get the current `version`, then retry.

**`OPEN_QUESTIONS_PRESENT` from `request_review`** — only older Kstonebase servers return it; current ones accept review requests while questions are open. On an older server, call `list_open_questions`, resolve or dismiss each item with `update_open_question` (ask the user for answers you don't have), then retry.

**`STALE_QUESTION` from `update_open_question` / `delete_open_question`** — the item changed after your read. Call `read_open_question` for its current `updatedAt` and the spec's `version`, check that the change still makes sense, then retry with both.

**`MARKER_NOT_FOUND` / `MARKER_AMBIGUOUS`** — the item's marker was edited away, or identical markers exist. Nothing was changed. Re-read the spec, restore or reword the marker text (or delete the item), then retry.

**`SPEC_LOCKED` on a spec in Needs Review** — `start_new_version` does not unlock it; a human must move it back to Draft in Kstonebase. Answering an open question is the exception: `update_open_question` with only `answer` and `status: "RESOLVED"` works and moves the spec back to Draft (older servers refuse it with `SPEC_LOCKED` too).

**Every open-question tool except `list_open_questions` fails with `NOT_FOUND` or `INTERNAL_ERROR`** — the Kstonebase deployment predates the open-question routes. See the backend prerequisite under [Open questions and assumptions](#open-questions-and-assumptions).

**Legacy `.kstonebase.json` shape rejected at startup** — the binding format changed; the CLI prints a remediation pointing to the new shape. Update the file.

**`ERR_MODULE_NOT_FOUND` under `npx`** — try `bunx` instead. It often resolves stale npm caches.

**Plain-HTTP `apiUrl`** — only `localhost` / `127.0.0.1` / `::1` are allowed by default. For any other host, pass `--allow-insecure` (self-hosted dev only).

## 📝 Changelog

Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## 📄 License

[Apache License 2.0](./LICENSE) © Ravi Tecnologia.
