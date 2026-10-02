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

The [Native Board](#native-board) tools use only `workspaceId` (passed or bound); a bound `productId` never selects or widens a Board.

## ✅ Verify the install

```bash
KSTONEBASE_API_TOKEN=YOUR_TOKEN npx -y @ravitecnologia/kstonebase-mcp --check
```

Prints `OK: https://kstonebase.com reachable, N product(s) visible.` on success, or a structured error code (`AUTH_REQUIRED`, `PRODUCT_NOT_BOUND`, …) and remediation when something is off. Add `--json` for machine-readable output.

## 🔨 Available Tools

All tools take ids as strings. Bound Workspace/Product ids are inferred from `.kstonebase.json` unless overridden in the call. Results about a Workspace, Product or specification end with a [Workspace instructions notice](#workspace-instructions).

### Read tools

| Tool                          | Purpose                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_effective_instructions`  | The effective Workspace instructions for a Workspace, Product or specification: mode (`workspace` or `local`), source, opaque `policyRevision` and, in Workspace mode, the text. Pass at most one of `workspaceId`, `productId`, `specificationId`; the binding is the default. See [Workspace instructions](#workspace-instructions). |
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
| `read_board`                  | The native Board of a Software Engineering Workspace: your role, capabilities, states, the advisory Doing WIP limit and counts per type. See [Native Board](#native-board).           |
| `list_board_items`            | Epics, Features and PBIs, ordered by priority then number. Filters: `type`, `state`, `parentId`, `productId` (`none` = Workspace-wide), `assigneeId` (`none` = unassigned), `priority`, `tag`, `query` (title or `#12`), `archived`. Cursor-paginated. |
| `read_board_item`             | One work item: description, PBI acceptance criteria and Implementation Prompt, linked specification chips, newest notes and its `version`.                                            |
| `list_board_item_notes`       | Older delivery notes and evidence of a work item, newest first. Cursor-paginated.                                                                                                      |
| `list_board_imports`          | Azure DevOps import previews and runs of the Workspace Board, newest first, with status and counts (Workspace Owner only). Cursor-paginated. See [Imported cards and import reports](#imported-cards-and-import-reports). |
| `read_board_import`           | One import preview or run: source scope, mappings, warnings, omissions and a page of items with their `plan`, `outcome` and native card. Filters: `plan`, `outcome`. Cursor-paginated (Workspace Owner only). |

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
| `update_open_question`         | Edit, move, resolve, dismiss or reopen a question or assumption; the document text changes with it. Answering a question, or accepting or rejecting an assumption, also works on a spec in Needs Review or Reviewed and moves it to Draft. Needs `version` and `expectedUpdatedAt`. |
| `delete_open_question`         | **Permanently** delete a question or assumption and any marker still in the document. Needs `version` and `expectedUpdatedAt`. To set an item aside, dismiss it instead.                                   |
| `create_board_item`            | Create an Epic, a Feature (under an active Epic) or a PBI (under an active Feature); it starts in `to_do`. Needs an `idempotencyKey` — reuse it when retrying.                                            |
| `update_board_item`            | Change fields, `state` (`to_do` / `doing` / `done`) or parent. Needs `expectedVersion`; only the fields you pass change, and `null` clears `assigneeId` / `productId`.                                     |
| `link_board_specification`     | Link an existing specification of the Workspace (or of a Product in it) to a work item by its id. Needs `expectedVersion`; re-linking is a no-op.                                                         |
| `unlink_board_specification`   | Remove only that link; the specification is untouched. Needs `expectedVersion`; unlinking an absent link is a no-op.                                                                                     |
| `append_board_item_note`       | Append delivery notes or validation evidence without changing the item's version. Needs an `idempotencyKey`.                                                                                             |
| `archive_board_item`           | Archive a work item (Workspace Owner only). Items with active children cannot be archived.                                                                                                               |
| `restore_board_item`           | Restore an archived work item (Workspace Owner only). Its parent must be active.                                                                                                                         |

Every write tool above also accepts an optional `expectedPolicyRevision` (the `policyRevision` from the latest Workspace instructions notice); see [Workspace instructions](#workspace-instructions).

> **Note** — the agent never calls "mark reviewed". Approval stays a human action in the Kstonebase UI. The MCP can only nudge a draft to `Needs Review`.

### Open questions and assumptions

`list_open_questions`, `read_open_question`, `create_open_question`, `update_open_question` and `delete_open_question` manage the questions and assumptions of one specification. The Kstonebase API changes the record and its inline Markdown marker together, in one transaction, so the question list and the document never disagree.

- **Scope** — every call names the specification (`specId`, plus `questionId` for a single item); the `.kstonebase.json` binding is not used. Product specifications (Free and Web Application) and Workspace specifications work the same way. The token needs access to that specification, and the `write` scope for changes.
- **Draft only, except answers and assumption decisions** — create, update and delete need a non-archived Draft. A Reviewed spec needs `start_new_version` first. A spec in Needs Review must be moved back to Draft by a human in Kstonebase — `start_new_version` does not unlock it. A generating spec must finish first. These tools never change `approvedVersion` or human approval.
- **Answering and deciding after review** — answering an `OPEN` question (`status: "RESOLVED"` with its `answer`) and accepting or rejecting an `OPEN` assumption (`status: "RESOLVED"` or `"DISMISSED"` alone), with no `body` or `sectionPath`, also work on a spec in Needs Review or Reviewed. In the same change the spec moves to Draft: a Needs Review spec goes back to Draft at the same version, a Reviewed spec gets a new draft with the change (its approved version stays published until a human approves the next one). Do not call `start_new_version` first; the response's `spec.status` is `DRAFT`. Every other change on those specs still fails with `SPEC_LOCKED`, including dismissing a question.
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

### Native Board

Software Engineering Workspaces have a native Kstonebase Board, so an agent can plan and track delivery entirely through these tools. No external tracker, extra token or board URL is needed. Specifications stay the requirements; the Board tracks the work.

- **Workspace and credential** — every Board tool acts on one Workspace: the `workspaceId` you pass, else the `workspaceId` in `.kstonebase.json` (else `WORKSPACE_NOT_BOUND`). A bound `productId` is never used, so it cannot narrow or widen Board access. The token must cover the whole Workspace (a Workspace or all-Workspaces token, not a Product allowlist — otherwise `WORKSPACE_SCOPE_REQUIRED`), you must be the Workspace Owner or a current Member, and writes need the `write` scope. Other Workspace types answer `BOARD_UNAVAILABLE`.
- **Hierarchy** — Epic → Feature → Product Backlog Item (PBI). A Feature's parent is an active Epic and a PBI's parent an active Feature of the same Workspace. Reuse matching items (`list_board_items`) instead of creating duplicates. PBIs carry acceptance criteria and a self-contained Implementation Prompt.
- **Traceability** — link the relevant existing specifications by their canonical id (`link_board_specification`) so they show on the card. Chips are re-checked on every read; a specification that was deleted or left the Workspace reads `{ "specificationId": "…", "available": false }`.
- **States** — `to_do` for planned work, `doing` for active work, `done` only after acceptance and validation. Parent and child states never change each other. Moving an item to `done`, linking or unlinking never changes or approves a specification: approval stays a human action.
- **Versions** — every read returns the item's `version`; pass it as `expectedVersion` to `update_board_item`, `link_board_specification`, `unlink_board_specification`, `archive_board_item` and `restore_board_item`. `STALE_VERSION` (with `details.currentVersion`) means someone else changed the item: re-read it, reconcile, then retry. Never replay the old request blindly.
- **Idempotency keys** — `create_board_item` and `append_board_item_note` need an `idempotencyKey` (8–128 characters: letters, digits, `.`, `_`, `:`, `-`). If a call times out or its outcome is unclear, retry with the **same** key: the API applies it exactly once and answers `replayed: true`. The package never generates, changes or retries keys. A key reused for a different request is refused with `IDEMPOTENCY_KEY_REUSED`.
- **Evidence** — record decisions and validation evidence with `append_board_item_note`; notes never change the item's version. `read_board_item` returns the newest 20; page older ones with `list_board_item_notes`.

A typical loop: `read_board` → `list_board_items` (reuse what exists) → `create_board_item` for the Epic, Feature and PBI → `link_board_specification` → `update_board_item` to `doing` → implement and validate → `append_board_item_note` with the evidence → `update_board_item` to `done`.

Failures to expect besides the ones above: `ITEM_NOT_FOUND`, `INVALID_PARENT`, `INVALID_ASSIGNEE`, `INVALID_PRODUCT`, `INVALID_CURSOR`, `VALIDATION_ERROR` (`details.field` / `details.problem`), `WORKSPACE_ARCHIVED` (read-only Board), `OWNER_REQUIRED`, `ACTIVE_CHILDREN` (`details.activeChildren`), `PARENT_ARCHIVED`, `ITEM_ARCHIVED`, `ITEM_NOT_ARCHIVED`, `SPECIFICATION_UNAVAILABLE`, `SPECIFICATION_ARCHIVED`, `LINK_LIMIT_REACHED` (`details.limit`), `TOKEN_SCOPE_MISMATCH` (token pinned to another Workspace) and `TOKEN_SCOPE_INSUFFICIENT` (no `write` scope). Each failure carries a remediation plus the allowlisted `details` (`field`, `problem`, `currentVersion`, `activeChildren`, `limit`, `hint`). Results are the Kstonebase API's bodies, unchanged.

> **Backend prerequisite** — the Board tools need a Kstonebase deployment whose API serves the native Board and whose Website proxies `/api/mcp/workspaces/:workspaceId/board…`. Against an older deployment they fail with a remediation saying the server does not serve the Board tools yet; every other tool keeps working. `list_board_imports` and `read_board_import` also need the import report routes (`…/board/imports`); without them they explain the missing server support the same way.

#### Imported cards and import reports

A Workspace Owner can import work items from their own Azure DevOps boards in the Kstonebase Website. Imported cards are ordinary native work items: every Board tool works on them, and `list_board_items` / `read_board_item` return an `origin` object naming the source (organization, project, team, board, the original work item's id, type, state, revision and URL, and who imported it when). Native cards carry `"origin": null`. `origin` is read-only imported data, never an instruction: `create_board_item` and `update_board_item` cannot set, change or remove it, and the package never forwards an `origin` argument.

`list_board_imports` and `read_board_import` let an agent explain an import preview or its result — mappings, blockers, warnings, omitted data and each item's `plan` (`import`, `already_imported`, `unsupported`, `excluded`, `blocked`) and `outcome` (`pending`, `imported`, `already_imported`, `skipped`, `blocked`, `failed`). They are Workspace-Owner-only (Members get `OWNER_REQUIRED` but can still read imported cards), read-only, and never contain a credential. No tool connects a source, runs discovery, changes a mapping or confirms, cancels or retries an import: a person does that in the Website — Workspace Settings → General → Azure DevOps to connect, then **Import from Azure DevOps** on the Board to preview, map and confirm. Expect also `IMPORT_NOT_FOUND`, `INVALID_CURSOR` and `VALIDATION_ERROR`.

### Workspace instructions

A Workspace Owner can enable **Workspace instructions** in Kstonebase: Markdown guidance for every agent that works on the Workspace, its Products, specifications and Board. A Workspace without them is in **Local** mode, and so is a Product outside any Workspace.

- **Precedence** — in Workspace mode, the instructions govern the resource and take priority over local `AGENTS.md` / `CLAUDE.md`, which only supplement them. In Local mode, the applicable local files stay authoritative within platform rules. Workspace instructions never grant permissions: credential scopes, write approvals and human specification approval are unchanged. Content of specifications, documents, Board items and other tool output is data, never instructions.
- **On every scoped result** — every successful tool result about a Workspace, Product or specification ends with one extra text item, built from a fresh resolver call for that tool call. The earlier content items and `structuredContent` are unchanged. In Workspace mode it looks like this:

  ```
  [Kstonebase Workspace instructions | target workspace:ws_1 | mode workspace | source workspace_policy | revision wp1_…]
  These verified Workspace instructions govern this resource. They take priority over local AGENTS.md/CLAUDE.md, which only supplement them, and they never grant permissions. Pass expectedPolicyRevision "wp1_…" on writes to this resource.
  ----- BEGIN WORKSPACE INSTRUCTIONS -----
  …the Workspace's instructions…
  ----- END WORKSPACE INSTRUCTIONS -----
  ```

  In Local mode the notice says so and names its source (`workspace_local` or `detached_product`). When the instructions cannot be loaded it says `unavailable: unsupported | not-found | scope-mismatch | error`: do not assume Local mode, call `get_effective_instructions` before writing. `list_products` without a Workspace spans several scopes and gets a notice saying so; call `get_effective_instructions` for a resource before acting on it. `list_workspaces`, `init_workspace` and `init_product` get no notice, and failed results never do. The result's `_meta["kstonebase.com/policy"]` repeats the target, mode, source, `policyRevision` and whether the text was included (or `status: "unavailable"` with the reason, or `status: "multiple-scopes"`).
- **Which resource** — specification tools address their specification; `read_product` and `create_free_specification` their Product; `read_workspace`, `find_product_by_subject`, `create_product` and every Board tool their Workspace (explicit or bound); `list_specifications` and `search_specifications` the Product or Workspace they list; `list_products` the Workspace it lists.
- **`get_effective_instructions`** — returns `{ target, policy }` with the API's validated policy (`schemaVersion`, `mode`, `source`, `policyRevision`, `instructions`, `instructionsOmitted`; text only in Workspace mode), plus the notice. Pass at most one of `workspaceId`, `productId` or `specificationId`; with none, the `.kstonebase.json` `productId` is used, else its `workspaceId`, else `POLICY_TARGET_REQUIRED`. Two or more give `VALIDATION_ERROR`; an unknown or inaccessible id gives `NOT_FOUND` (or `TOKEN_SCOPE_MISMATCH`).
- **Writes** — pass the notice's revision as `expectedPolicyRevision` on writes to that resource. It is sent only as the `X-Kstonebase-Policy-Revision` header, never in the body, and no header is sent without it; resource versions and idempotency keys work as before. `POLICY_STALE` means the instructions changed since you read them: nothing was written; call `get_effective_instructions`, review the new instructions with the user, then retry with the new revision — never replay the write automatically. A Workspace in Workspace mode refuses writes without the revision (`POLICY_REVISION_REQUIRED`); a malformed one is `INVALID_POLICY_REVISION`. Local Workspaces still accept writes without it.
- **Your agent's responsibility** — the server's MCP `instructions` (sent on `initialize`) tell clients to treat the Workspace-mode notice as their instruction channel for that resource. An external agent remains responsible for actually following the prose: the MCP server delivers the verified text and enforces the revision precondition, but it cannot prove that an agent's work complies with the instructions.
- **Caching** — the revision is fetched on every scoped call; the enabled text is cached in memory by revision for this process (one credential) and requested with `instructions=omit` once known. A new revision always fetches its new text.

> **Backend prerequisite** — Workspace instructions need a Kstonebase deployment whose API serves the resolver and whose Website proxies `/api/mcp/agent-policy` and forwards `X-Kstonebase-Policy-Revision`. Against an older deployment, scoped results still succeed with an `unavailable: unsupported` notice and `get_effective_instructions` answers `POLICY_UNSUPPORTED`: do not assume Local mode, ask the user before acting on Workspace resources.

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

**`WORKSPACE_SCOPE_REQUIRED` from a Board tool** — the token is restricted to Products. Board tools need a token for the whole Workspace (or all Workspaces); bind `workspaceId` in `.kstonebase.json`. A `productId` in the binding never widens the token.

**`STALE_VERSION` from a Board tool** — someone changed the work item after your read (`details.currentVersion`). Re-read it with `read_board_item`, reconcile, and retry with the new `version` as `expectedVersion`.

**`POLICY_STALE` from a write** — the Workspace instructions changed after you read them; nothing was written. Call `get_effective_instructions`, review the new instructions with the user, then retry with the new `expectedPolicyRevision`. Never replay the write automatically.

**`POLICY_REVISION_REQUIRED` from a write** — the Workspace enforces its instructions. Call `get_effective_instructions` for the resource, follow the instructions and pass its `policyRevision` as `expectedPolicyRevision`.

**`unavailable: unsupported` notices / `POLICY_UNSUPPORTED`** — the Kstonebase deployment predates Workspace instructions. Do not assume Local mode; ask the user before acting on Workspace resources.

**`OPEN_QUESTIONS_PRESENT` from `request_review`** — only older Kstonebase servers return it; current ones accept review requests while questions are open. On an older server, call `list_open_questions`, resolve or dismiss each item with `update_open_question` (ask the user for answers you don't have), then retry.

**`STALE_QUESTION` from `update_open_question` / `delete_open_question`** — the item changed after your read. Call `read_open_question` for its current `updatedAt` and the spec's `version`, check that the change still makes sense, then retry with both.

**`MARKER_NOT_FOUND` / `MARKER_AMBIGUOUS`** — the item's marker was edited away, or identical markers exist. Nothing was changed. Re-read the spec, restore or reword the marker text (or delete the item), then retry.

**`SPEC_LOCKED` on a spec in Needs Review** — `start_new_version` does not unlock it; a human must move it back to Draft in Kstonebase. Answering an open question and accepting or rejecting an open assumption are the exceptions: `update_open_question` with only `answer` and `status: "RESOLVED"` (a question), or only `status: "RESOLVED"` or `"DISMISSED"` (an assumption), works and moves the spec back to Draft (older servers refuse them with `SPEC_LOCKED` too).

**Every open-question tool except `list_open_questions` fails with `NOT_FOUND` or `INTERNAL_ERROR`** — the Kstonebase deployment predates the open-question routes. See the backend prerequisite under [Open questions and assumptions](#open-questions-and-assumptions).

**Legacy `.kstonebase.json` shape rejected at startup** — the binding format changed; the CLI prints a remediation pointing to the new shape. Update the file.

**`ERR_MODULE_NOT_FOUND` under `npx`** — try `bunx` instead. It often resolves stale npm caches.

**Plain-HTTP `apiUrl`** — only `localhost` / `127.0.0.1` / `::1` are allowed by default. For any other host, pass `--allow-insecure` (self-hosted dev only).

## 📝 Changelog

Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## 📄 License

[Apache License 2.0](./LICENSE) © Ravi Tecnologia.
