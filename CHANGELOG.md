# Changelog

Notable changes to `@ravitecnologia/kstonebase-mcp`. Versions before 2.2.0 are described in the git history.

## Unreleased

### Added

- Native Board tools for Software Engineering Workspaces (Kstonebase MCP spec `features/mcp-board-tools.md` §2.1, backed by the API's `/mcp/workspaces/:workspaceId/board…` routes): `read_board`, `list_board_items`, `read_board_item`, `list_board_item_notes`, `create_board_item`, `update_board_item`, `link_board_specification`, `unlink_board_specification`, `append_board_item_note`, `archive_board_item` and `restore_board_item`, on both the stdio and `--http` transports. Names, titles, descriptions, annotations (all with `idempotentHint: true`) and input schemas match the Kstonebase-hosted endpoint; results are the API bodies, unchanged.
- Board tools target only a Workspace: the passed `workspaceId`, else the `.kstonebase.json` `workspaceId`, else `WORKSPACE_NOT_BOUND` before any request. A bound `productId` is never used, so it cannot narrow or widen Board access; Product-restricted credentials get the API's `WORKSPACE_SCOPE_REQUIRED` with its hint.
- `create_board_item` and `append_board_item_note` require an `idempotencyKey`, forwarded exactly as given; the package never generates, swaps or retries keys. A Board request that fails in flight reports `INTERNAL_ERROR` telling the agent to re-read and to retry only with the same key.
- `KstonebaseClient` Board methods (`readBoard`, `listBoardItems`, `readBoardItem`, `listBoardItemNotes`, `createBoardItem`, `updateBoardItem`, `linkBoardSpecification`, `unlinkBoardSpecification` — DELETE with a JSON `{expectedVersion}` body — `appendBoardItemNote`, `archiveBoardItem`, `restoreBoardItem`). PATCH bodies carry only the fields given; explicit `null` clears `assigneeId` / `productId`.
- Error codes `BOARD_UNAVAILABLE`, `ITEM_NOT_FOUND`, `WORKSPACE_ARCHIVED`, `OWNER_REQUIRED`, `INVALID_PARENT`, `INVALID_ASSIGNEE`, `INVALID_PRODUCT`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REUSED`, `ACTIVE_CHILDREN`, `PARENT_ARCHIVED`, `ITEM_ARCHIVED`, `ITEM_NOT_ARCHIVED`, `SPECIFICATION_UNAVAILABLE`, `SPECIFICATION_ARCHIVED` and `LINK_LIMIT_REACHED`. For Board tools the API's `details.code` is the tool code — credential refusals included (`WORKSPACE_SCOPE_REQUIRED`, `TOKEN_SCOPE_MISMATCH`, `TOKEN_SCOPE_INSUFFICIENT`) — and the details `field`, `problem`, `currentVersion`, `activeChildren`, `limit` and `hint` are passed on. `STALE_VERSION` carries `currentVersion` and tells the agent to re-read and reconcile, never to replay. A Board route that answers without any error code (an older deployment) is explained as missing server support. Error codes and details of every other tool are unchanged.
- `init_workspace` and `init_product` list the Board tools in the generated CLAUDE.md / AGENTS.md for Workspace bindings. README documents the native Board workflow; the ChatGPT app manifest declares the new tools.

**Requires** a Kstonebase deployment whose API serves the native Board and whose Website proxies `/api/mcp/workspaces/:workspaceId/board…`.

### Changed

- `request_review` no longer describes an open-question gate: Kstonebase accepts review requests, and Owners approve versions, while open questions remain (Kstonebase Business PDR-0007, changed 2026-09-26). The tool still maps `OPEN_QUESTIONS_PRESENT` from older servers.
- `update_open_question` describes answering after review: resolving an `OPEN` question with its answer (and no `body` or `sectionPath`) also works on a specification in Needs Review or Reviewed, and the Kstonebase API moves it to Draft in the same change — back to Draft at the same version from Needs Review, a new draft from Reviewed — so agents answer directly instead of calling `start_new_version` first (Kstonebase MCP spec `features/mcp-open-question-management.md` §11). The `SPEC_LOCKED` remediations for Reviewed and Needs Review specs name this exception. The description is byte-identical to the Kstonebase-hosted MCP endpoint's. Older servers still refuse such answers with `SPEC_LOCKED`.
- `update_open_question` also describes accepting (`RESOLVED`) or rejecting (`DISMISSED`) an `OPEN` assumption after review: with no `body` or `sectionPath` it works on a specification in Needs Review or Reviewed, and the Kstonebase API moves it to Draft in the same change, exactly like an answer (Kstonebase MCP spec `features/mcp-open-question-management.md`, decision of 2026-09-26 on assumptions). The `SPEC_LOCKED` remediations name both exceptions. Dismissing a question stays Draft-only. Older servers refuse these changes with `SPEC_LOCKED`.

## 2.2.0

Additive release: agents can manage a specification's open questions and assumptions (Kstonebase MCP spec `features/mcp-open-question-management.md`).

**Requires** a Kstonebase deployment whose API serves the open-question routes and whose Website proxies them under `/api/mcp/specifications/:specId/open-questions` (GET, POST) and `/api/mcp/specifications/:specId/open-questions/:questionId` (GET, PATCH, and DELETE with a JSON body). Against an older deployment the four new tools fail; `list_open_questions` keeps working.

### Added

- `read_open_question`, `create_open_question`, `update_open_question` and `delete_open_question` on both the stdio and `--http` transports, with the schemas, descriptions and annotations pinned by the shared open-question contract. Changes need a non-archived Draft and the spec `version`; updates and deletes also need the item's `updatedAt` as `expectedUpdatedAt`. The API changes the record and its Markdown marker together. `delete_open_question` is permanent; dismissing keeps the item and can be undone by reopening.
- `KstonebaseClient` methods `readOpenQuestion`, `createOpenQuestion`, `updateOpenQuestion` and `deleteOpenQuestion` (DELETE sends a JSON body). Tokens are sent exactly as given, undefined keys are omitted and explicit `null`s are kept; empty, `.` and `..` ids are rejected before any request.
- Error codes `STALE_QUESTION`, `MARKER_NOT_FOUND`, `MARKER_AMBIGUOUS`, `SECTION_AMBIGUOUS`, `ANSWER_REQUIRED`, `INVALID_TRANSITION` and `SPEC_ARCHIVED`, each with a remediation that asks the agent to re-read instead of retrying blindly. A missing section — an unknown `sectionPath`, or a reopen whose recorded heading no longer exists — is reported as `NOT_FOUND`, as on the Kstonebase-hosted MCP endpoint; its remediation and the `sectionPath` / `reason` / `hint` details say which case it is.
- Tool failures carry the API's actionable `details` (`hint`, `reason`, `fields`, `status`, `sectionPath`, `from`, `to`), in the structured result and in the text.
- `init_workspace` and `init_product` list the new tools in the generated CLAUDE.md / AGENTS.md.

### Changed

- `list_open_questions` passes through the additive `spec` metadata and the `specificationId` / `resolvedAt` item fields when the API returns them. Its arguments and default filtering are unchanged.
- For specification and question codes, error mapping reads the specific `error.details.code` before the generic envelope code. This fixes codes that were reported wrongly: `OPEN_QUESTIONS_PRESENT` and `PRODUCT_TYPE_MISMATCH` (were `INTERNAL_ERROR`), archived specs (were `TOKEN_SCOPE_MISMATCH`, now `SPEC_ARCHIVED`) and rejected lifecycle transitions (were `INTERNAL_ERROR`, now `INVALID_TRANSITION`). Credential, scope and binding failures keep their existing codes: a token without the `write` scope, for example, still reports `TOKEN_SCOPE_MISMATCH`, with `TOKEN_SCOPE_INSUFFICIENT` as the message.
- The `SPEC_LOCKED` remediation follows the spec status and no longer suggests `start_new_version` for a spec in Needs Review. The `STALE_VERSION`, `OPEN_QUESTIONS_PRESENT`, `NOT_FOUND`, `VALIDATION_ERROR` and `INTERNAL_ERROR` remediations were reworded; writes are never retried automatically.
- The MCP `serverInfo.version` now reports the package version (it said 2.0.0).
