# Changelog

Notable changes to `@ravitecnologia/kstonebase-mcp`. Versions before 2.2.0 are described in the git history.

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
