// MCP-side error mapping (per Kstonebase spec "mcp-server" §5 "Error mapping",
// "mcp-open-question-management" §6 and "mcp-board-tools" §2.1). Translates
// Kstonebase API error envelopes into MCP error codes the agent can reason
// about, each carrying a short remediation string plus the API's actionable
// details.

export type McpStructuredCode =
  | "AUTH_FAILED"
  | "TOKEN_EXPIRED"
  | "TOKEN_REVOKED"
  | "TOKEN_SCOPE_MISMATCH"
  | "TOKEN_SCOPE_INSUFFICIENT"
  | "PRODUCT_NOT_BOUND"
  | "WORKSPACE_NOT_BOUND"
  | "WORKSPACE_SCOPE_REQUIRED"
  | "PRODUCT_TYPE_MISMATCH"
  | "PRODUCT_TYPE_UNSUPPORTED"
  | "NOT_IN_WORKSPACE"
  | "LEGACY_BINDING_DETECTED"
  | "SPEC_LOCKED"
  | "SPEC_ARCHIVED"
  | "OPEN_QUESTIONS_PRESENT"
  | "STALE_VERSION"
  | "STALE_QUESTION"
  | "MARKER_NOT_FOUND"
  | "MARKER_AMBIGUOUS"
  | "SECTION_AMBIGUOUS"
  | "ANSWER_REQUIRED"
  | "INVALID_TRANSITION"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  // Native Board codes (Kstonebase API › features/workspace-board.md §9.3).
  | "BOARD_UNAVAILABLE"
  | "ITEM_NOT_FOUND"
  | "WORKSPACE_ARCHIVED"
  | "OWNER_REQUIRED"
  | "INVALID_PARENT"
  | "INVALID_ASSIGNEE"
  | "INVALID_PRODUCT"
  | "INVALID_CURSOR"
  | "IDEMPOTENCY_KEY_REUSED"
  | "ACTIVE_CHILDREN"
  | "PARENT_ARCHIVED"
  | "ITEM_ARCHIVED"
  | "ITEM_NOT_ARCHIVED"
  | "SPECIFICATION_UNAVAILABLE"
  | "SPECIFICATION_ARCHIVED"
  | "LINK_LIMIT_REACHED"
  // Board import report code (API › features/azure-devops-board-import.md
  // §8.3; the MCP surface only exposes the report reads).
  | "IMPORT_NOT_FOUND";

export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/**
 * The `error.details` keys the agent needs to decide its next step
 * (open-question contract §4). Values are passed through exactly as the API
 * sent them.
 */
const ACTIONABLE_DETAIL_KEYS = [
  "hint",
  "reason",
  "fields",
  "status",
  "sectionPath",
  "from",
  "to",
] as const;

export type ActionableDetailKey = (typeof ACTIONABLE_DETAIL_KEYS)[number];

/**
 * The `error.details` keys a Board tool passes on (MCP › mcp-board-tools.md
 * §2.1). Anything else the Board API sends — notably the full current `item`
 * that accompanies STALE_VERSION — is dropped: the agent re-reads instead.
 */
const BOARD_DETAIL_KEYS = [
  "field",
  "problem",
  "currentVersion",
  "activeChildren",
  "limit",
  "hint",
] as const;

export type BoardDetailKey = (typeof BOARD_DETAIL_KEYS)[number];

export type McpFailureDetails = Partial<
  Record<ActionableDetailKey | BoardDetailKey, unknown>
>;

/**
 * How an API error is mapped. "board" is used by the native Board tools only:
 * there the API's `details.code` is always the tool error code, credential
 * codes included (MCP › mcp-board-tools.md §2.1), and Board remediations and
 * details apply. "board-import" is the same mapping for the Board import
 * report reads (list_board_imports, read_board_import; spec §2.2), with
 * remediations worded for Owner-only reports. "default" keeps the existing
 * vocabulary for every other tool.
 */
export type ErrorMappingMode = "default" | "board" | "board-import";

export interface McpFailure {
  code: McpStructuredCode;
  message: string;
  remediation: string;
  /** Present only when the API returned at least one actionable detail. */
  details?: McpFailureDetails;
}

export class McpToolError extends Error {
  constructor(
    public readonly code: McpStructuredCode,
    message: string,
    public readonly remediation: string,
    public readonly details?: McpFailureDetails,
  ) {
    super(message);
    this.name = "McpToolError";
  }

  toFailure(): McpFailure {
    const failure: McpFailure = {
      code: this.code,
      message: this.message,
      remediation: this.remediation,
    };
    if (this.details && Object.keys(this.details).length > 0) {
      failure.details = this.details;
    }
    return failure;
  }
}

const REMEDIATIONS: Record<McpStructuredCode, string> = {
  AUTH_FAILED:
    "Regenerate a Personal Access Token from /settings/developer and update KSTONEBASE_API_TOKEN.",
  TOKEN_EXPIRED:
    "The token expired. Generate a new one from /settings/developer.",
  TOKEN_REVOKED:
    "The token was revoked. Generate a new one from /settings/developer.",
  TOKEN_SCOPE_MISMATCH:
    "The token isn't scoped to this product. Use a token whose allowlist includes it, or remove the allowlist.",
  TOKEN_SCOPE_INSUFFICIENT:
    "The token is missing the `write` scope. Regenerate it from /settings/developer with write access.",
  PRODUCT_NOT_BOUND:
    "Call list_products, pick one, then add it to .kstonebase.json or set KSTONEBASE_PRODUCT_ID.",
  WORKSPACE_NOT_BOUND:
    "Call list_workspaces, pick one, then add it to .kstonebase.json as `workspaceId` or set KSTONEBASE_WORKSPACE_ID.",
  WORKSPACE_SCOPE_REQUIRED:
    "Re-bind this credential at the Workspace level (workspaceId in .kstonebase.json, no product allowlist) so it can create Products in the Workspace.",
  PRODUCT_TYPE_MISMATCH:
    "The filter you passed isn't compatible with this product's type. Drop the filter or call against a matching product.",
  PRODUCT_TYPE_UNSUPPORTED:
    'This tool only supports specificationManagementType="free" in v1. Omit the field or pass "free" explicitly.',
  NOT_IN_WORKSPACE:
    "This tool requires a Workspace binding. Set `workspaceId` in .kstonebase.json or pass it explicitly.",
  LEGACY_BINDING_DETECTED:
    'Edit .kstonebase.json: rename the "workspaceId" field to "productId" (the value points at a Product under the new model). To bind to a Workspace, create one and set both ids.',
  SPEC_LOCKED:
    "The specification is not an editable Draft. If it is Reviewed, call start_new_version first. If it is in Needs Review, a human must move it back to Draft in Kstonebase (start_new_version does not unlock Needs Review). If it is generating, wait for it to finish. Answering an open question or accepting or rejecting an open assumption is the exception: update_open_question with only the answer and status RESOLVED (a question), or only status RESOLVED or DISMISSED (an assumption), also works on a Reviewed or Needs Review specification and moves it to Draft. Re-read before retrying.",
  SPEC_ARCHIVED:
    "The specification is archived, so it cannot be changed. A human must restore it in Kstonebase first; do not retry until it is restored.",
  OPEN_QUESTIONS_PRESENT:
    "Open questions or assumptions remain on this spec. Call list_open_questions, then resolve or dismiss each one with update_open_question (ask the user when an answer is needed) before retrying.",
  STALE_VERSION:
    "Another write changed the specification after your read, so nothing was changed. Re-read it (read_specification, or read_open_question for question tools) to get the current version, check that your change still applies, then retry with that version.",
  STALE_QUESTION:
    "The question or assumption changed after you read it, so nothing was changed. Re-read it with read_open_question to get its current updatedAt and the specification's current version, check that your change still applies, then retry with both. Never replay the old request.",
  MARKER_NOT_FOUND:
    "The item's inline marker is no longer in the document, so nothing was changed. Re-read the specification (read_specification): restore the marker text, or delete the item with delete_open_question, then re-read the item before trying again.",
  MARKER_AMBIGUOUS:
    "The item's marker cannot be told apart from an identical one, or the target section already holds the same text, so nothing was changed. Re-read the specification, make the text or its section distinct, then re-read the item before trying again.",
  SECTION_AMBIGUOUS:
    "sectionPath matches more than one heading, so nothing was changed. Re-read the specification and pass a heading that identifies exactly one section, or rename the duplicate heading first.",
  ANSWER_REQUIRED:
    "Resolving a question needs a non-blank answer. Call update_open_question again with an answer and status RESOLVED, using the version and updatedAt from your latest read.",
  INVALID_TRANSITION:
    "That change is not allowed from the current state, so nothing was changed. Re-read the current state first. For open questions, reopen a RESOLVED or DISMISSED item with status OPEN alone before other edits, and do not combine body or sectionPath with a status change.",
  RATE_LIMITED:
    "You hit the per-token rate limit. Wait until the Retry-After window passes and try again.",
  NOT_FOUND:
    "The resource doesn't exist, isn't visible to this token, or (for question tools) doesn't belong to that specification. Re-check the ids with the matching list tool.",
  VALIDATION_ERROR:
    "Inspect the details — at least one argument failed validation. Fix the arguments instead of retrying them unchanged.",
  INTERNAL_ERROR:
    "The Kstonebase API hit an unexpected error. Retry a read once. Before retrying a write, re-read the current state: the change may already have been applied. If it persists, contact support.",
  BOARD_UNAVAILABLE:
    "This Workspace has no native Board: only Software Engineering Workspaces have one. Check workspaceId with list_workspaces. Report it to the user instead of falling back to another board.",
  ITEM_NOT_FOUND:
    "No such work item on this Workspace's Board. Use an id returned by list_board_items or read_board_item for this same Workspace; never guess ids.",
  WORKSPACE_ARCHIVED:
    "The Workspace is archived, so its Board is read-only. Reads still work; a human must restore the Workspace in Kstonebase before any change.",
  OWNER_REQUIRED:
    "Only the Workspace Owner can archive or restore work items. Ask the Owner to do it; retrying with the same credential will not help.",
  INVALID_PARENT:
    "The parent is not valid (details.problem: required, not-found, wrong-type, archived or epic-has-no-parent). An Epic has no parent, a Feature needs an active Epic and a PBI an active Feature of the same Workspace. Pick a valid parent with list_board_items, then retry.",
  INVALID_ASSIGNEE:
    "The assignee must be the Workspace Owner or a current Member. Pass a valid user id, or leave assigneeId out (on update, null clears it).",
  INVALID_PRODUCT:
    "productId must be an active Product currently in this Workspace (see list_products). Pass a valid id, or leave productId out (on update, null clears it).",
  INVALID_CURSOR:
    "The cursor is not valid for this list. Start again from the first page without a cursor and pass nextCursor back exactly as returned.",
  IDEMPOTENCY_KEY_REUSED:
    "This idempotencyKey was already used for a different request, so nothing was changed. Reuse a key only to retry the exact same request; use a new key for a genuinely new item or note.",
  ACTIVE_CHILDREN:
    "The work item still has active children (details.activeChildren), so it cannot be archived. Archive or move the children first, re-read the item, then retry.",
  PARENT_ARCHIVED:
    "The work item's parent is archived, so it cannot be restored. Restore the parent first, re-read the item, then retry.",
  ITEM_ARCHIVED:
    "The work item is archived, so it cannot be changed, linked or noted. The Workspace Owner can restore it with restore_board_item first.",
  ITEM_NOT_ARCHIVED:
    "The work item is not archived, so there is nothing to restore. Re-read it with read_board_item.",
  SPECIFICATION_UNAVAILABLE:
    "That specification cannot be linked from this Board: it is unknown, deleted, in another Workspace, or in a Product that is no longer in this Workspace. Find it with search_specifications or list_specifications and link it by its canonical id.",
  SPECIFICATION_ARCHIVED:
    "The specification is archived, so it cannot be linked. Link an active specification, or ask a human to restore it first.",
  LINK_LIMIT_REACHED:
    "The work item already links the maximum number of specifications (details.limit). Unlink one with unlink_board_specification before linking another.",
  IMPORT_NOT_FOUND:
    "No such import on this Workspace's Board. Use an id returned by list_board_imports for this same Workspace; never guess ids. Tools cannot start an import: a person connects Azure DevOps in Workspace Settings → General → Azure DevOps, then previews and confirms it with Import from Azure DevOps on the Board.",
};

// Board-specific wording for shared codes (MCP › mcp-board-tools.md §2.1,
// §3 and §4). Used only in "board" mode, so every other tool keeps its text.
const BOARD_REMEDIATIONS: Partial<Record<McpStructuredCode, string>> = {
  STALE_VERSION:
    "Someone else changed this work item after your read (details.currentVersion is its version now), so nothing was changed. Re-read it with read_board_item, reconcile your change with the current values, then retry with the new version as expectedVersion. Never replay the old request blindly or overwrite another person's change.",
  WORKSPACE_SCOPE_REQUIRED:
    "Board tools need a whole-Workspace credential, and this one is restricted to Products, so it never reaches the Workspace Board. Use a token bound to the Workspace (or to all Workspaces) and set workspaceId in .kstonebase.json. A productId binding never widens a credential.",
  TOKEN_SCOPE_MISMATCH:
    "This credential is pinned to another Workspace, so it cannot reach this Board. Pass the Workspace the credential is bound to, or use a credential for this Workspace.",
  NOT_FOUND:
    "The Workspace doesn't exist or you are not its Owner or a current Member (Product membership alone grants no Board access). Check workspaceId with list_workspaces.",
  VALIDATION_ERROR:
    "An argument failed validation (details.field and details.problem say which and why). Fix that argument instead of retrying it unchanged.",
  INTERNAL_ERROR:
    "The Kstonebase API hit an unexpected error. Retry a read once. Before retrying a write, re-read the work item: the change may already have been applied. Retry create_board_item or append_board_item_note only with the same idempotencyKey, never a new one.",
};

// SPEC_LOCKED next steps depend on the specification's status (open-question
// contract §4): only a Reviewed spec is unlocked by start_new_version, and
// answering an open question, or accepting or rejecting an open assumption,
// works on Reviewed and Needs Review specs without it (contract §11 and its
// decision of 2026-09-26 on assumptions: the change moves the spec to Draft
// by itself).
const SPEC_LOCKED_BY_STATUS: Record<string, string> = {
  REVIEWED:
    "The specification is Reviewed. Call start_new_version to open a Draft, re-read it for the new version, then retry. Answering an open question or accepting or rejecting an open assumption needs no new version: update_open_question with only the answer and status RESOLVED (a question), or only status RESOLVED or DISMISSED (an assumption), starts a new draft by itself.",
  NEEDS_REVIEW:
    "The specification is in Needs Review. start_new_version does not unlock it: a human must move it back to Draft in Kstonebase. Ask the user, then re-read before retrying. Answering an open question or accepting or rejecting an open assumption is the exception: update_open_question with only the answer and status RESOLVED (a question), or only status RESOLVED or DISMISSED (an assumption), moves it back to Draft by itself.",
  GENERATING:
    "The specification is still generating. Wait for generation to finish, re-read it, then retry.",
};

// A missing section keeps the existing NOT_FOUND code, as on the
// Kstonebase-hosted MCP endpoint. These remediations, plus the sectionPath /
// reason / hint details, tell the agent which of the two cases it hit.
const SECTION_MISSING =
  'No heading matches sectionPath (see details.sectionPath), so nothing was changed. Re-read the specification and pass an existing heading (for example "## Scope"). For open questions, omit sectionPath (create) or pass null (update) to use the end of the document.';

const SECTION_ANCHOR_STALE =
  "The heading this item was recorded under no longer exists (details.reason ANCHOR_STALE), so it cannot be reopened in place and nothing was changed. Re-read the specification and follow the hint: restore the heading, or record the item again with create_open_question.";

// Specification and question codes. The API sends them in `details.code`
// under a generic envelope (CONFLICT, BAD_REQUEST, NOT_FOUND, SPEC_LOCKED…),
// so `details.code` is consulted first for these.
const DETAIL_FIRST_CODES: Readonly<Record<string, McpStructuredCode>> = {
  SPEC_LOCKED: "SPEC_LOCKED",
  SPEC_ARCHIVED: "SPEC_ARCHIVED",
  OPEN_QUESTIONS_PRESENT: "OPEN_QUESTIONS_PRESENT",
  PRODUCT_TYPE_MISMATCH: "PRODUCT_TYPE_MISMATCH",
  STALE_VERSION: "STALE_VERSION",
  STALE_QUESTION: "STALE_QUESTION",
  MARKER_NOT_FOUND: "MARKER_NOT_FOUND",
  MARKER_AMBIGUOUS: "MARKER_AMBIGUOUS",
  SECTION_NOT_FOUND: "NOT_FOUND",
  SECTION_AMBIGUOUS: "SECTION_AMBIGUOUS",
  ANSWER_REQUIRED: "ANSWER_REQUIRED",
  INVALID_TRANSITION: "INVALID_TRANSITION",
};

// Credential, scope and binding codes keep the pre-2.2.0 resolution, per
// spec "mcp-open-question-management" §6 ("retain existing credential/auth
// failure vocabulary at the boundary"): the envelope code when there is one,
// else `details.code`, else the HTTP status. So FORBIDDEN +
// TOKEN_SCOPE_INSUFFICIENT still reports TOKEN_SCOPE_MISMATCH, as before.
const ENVELOPE_FIRST_CODES: Readonly<Record<string, McpStructuredCode>> = {
  AUTH_REQUIRED: "AUTH_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  TOKEN_SCOPE_MISMATCH: "TOKEN_SCOPE_MISMATCH",
  TOKEN_SCOPE_INSUFFICIENT: "TOKEN_SCOPE_INSUFFICIENT",
  WORKSPACE_SCOPE_REQUIRED: "WORKSPACE_SCOPE_REQUIRED",
  PRODUCT_TYPE_UNSUPPORTED: "PRODUCT_TYPE_UNSUPPORTED",
  NOT_IN_WORKSPACE: "NOT_IN_WORKSPACE",
};

// A Board route answered without any Kstonebase error code (typically an
// HTML 404/405 page): the deployment most likely predates the native Board
// (MCP › mcp-board-tools.md §4: explain missing server support).
const BOARD_ROUTE_UNSUPPORTED =
  "The Kstonebase server answered without a Board error code, so this deployment probably does not serve the native Board tools yet. Ask an administrator to update Kstonebase; the other tools keep working. Do not fall back to another board silently.";

// The same situation for the import report reads, whose routes are newer
// than the native Board ones (MCP › mcp-board-tools.md §2.2).
const BOARD_IMPORT_ROUTE_UNSUPPORTED =
  "The Kstonebase server answered without a Board error code, so this deployment probably does not serve the Board import report tools yet. Ask an administrator to update Kstonebase; the other Board tools keep working, and imported cards can still be read with list_board_items and read_board_item.";

// Import-report wording for shared codes (MCP › mcp-board-tools.md §2.2 and
// API › features/azure-devops-board-import.md §8.3). Reports are
// Workspace-Owner-only, read-only and never contain a credential; connecting
// a source and confirming an import stay human-only in the Website.
const BOARD_IMPORT_REMEDIATIONS: Partial<Record<McpStructuredCode, string>> = {
  OWNER_REQUIRED:
    "Azure DevOps import reports are visible to the Workspace Owner only. As a Member you can still read and work on every card, imported ones included, with list_board_items and read_board_item (an imported card's `origin` names its Azure DevOps source). Ask the Workspace Owner to review the report; retrying with the same credential will not help.",
  INVALID_CURSOR:
    "The cursor is not valid for this list. Start again from the first page without a cursor and pass nextCursor back exactly as returned, with the same arguments (for read_board_import: the same importId, plan and outcome).",
  VALIDATION_ERROR:
    "An argument failed validation (details.field and details.problem say which and why). limit is 1–100; plan is one of import, already_imported, unsupported, excluded, blocked; outcome is one of pending, imported, already_imported, skipped, blocked, failed. Fix that argument instead of retrying it unchanged.",
  INTERNAL_ERROR:
    "The Kstonebase API hit an unexpected error. Import report reads change nothing, so retry the read once; if it persists, contact support.",
};

/** The remediation a Board tool (or, in "board-import" mode, an import report tool) reports for `code`. */
export function boardRemediation(
  code: McpStructuredCode,
  mode: ErrorMappingMode = "board",
): string {
  const forImport =
    mode === "board-import" ? BOARD_IMPORT_REMEDIATIONS[code] : undefined;
  return forImport ?? BOARD_REMEDIATIONS[code] ?? REMEDIATIONS[code];
}

// Board refusals carry their specific code in `details.code` under a generic
// envelope (BAD_REQUEST, FORBIDDEN, NOT_FOUND, CONFLICT). In "board" mode that
// code is the tool error code, including the credential refusals the MCP
// routes send before any Board read (WORKSPACE_SCOPE_REQUIRED,
// TOKEN_SCOPE_MISMATCH, TOKEN_SCOPE_INSUFFICIENT).
const BOARD_DETAIL_CODES: Readonly<Record<string, McpStructuredCode>> = {
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  STALE_VERSION: "STALE_VERSION",
  BOARD_UNAVAILABLE: "BOARD_UNAVAILABLE",
  ITEM_NOT_FOUND: "ITEM_NOT_FOUND",
  WORKSPACE_ARCHIVED: "WORKSPACE_ARCHIVED",
  OWNER_REQUIRED: "OWNER_REQUIRED",
  INVALID_PARENT: "INVALID_PARENT",
  INVALID_ASSIGNEE: "INVALID_ASSIGNEE",
  INVALID_PRODUCT: "INVALID_PRODUCT",
  INVALID_CURSOR: "INVALID_CURSOR",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  ACTIVE_CHILDREN: "ACTIVE_CHILDREN",
  PARENT_ARCHIVED: "PARENT_ARCHIVED",
  ITEM_ARCHIVED: "ITEM_ARCHIVED",
  ITEM_NOT_ARCHIVED: "ITEM_NOT_ARCHIVED",
  SPECIFICATION_UNAVAILABLE: "SPECIFICATION_UNAVAILABLE",
  SPECIFICATION_ARCHIVED: "SPECIFICATION_ARCHIVED",
  LINK_LIMIT_REACHED: "LINK_LIMIT_REACHED",
  IMPORT_NOT_FOUND: "IMPORT_NOT_FOUND",
  WORKSPACE_SCOPE_REQUIRED: "WORKSPACE_SCOPE_REQUIRED",
  TOKEN_SCOPE_MISMATCH: "TOKEN_SCOPE_MISMATCH",
  TOKEN_SCOPE_INSUFFICIENT: "TOKEN_SCOPE_INSUFFICIENT",
  AUTH_REQUIRED: "AUTH_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * Map an HTTP response (status + parsed body) onto an `McpToolError`.
 * Specification and question codes are read from `error.details.code` first;
 * everything else resolves as it always has (envelope code, then
 * `details.code`, then the status code's standard meaning). Actionable
 * details (hint, reason, fields, status, sectionPath, from, to) travel with
 * the error so the agent can re-read and decide instead of retrying blindly.
 *
 * In "board" mode (native Board tools only) every known `details.code` wins,
 * the Board remediations apply and the Board detail allowlist (field,
 * problem, currentVersion, activeChildren, limit, hint) is passed on.
 * "board-import" (the import report reads) maps the same way with the
 * import-report remediations.
 */
export function mapApiError(
  status: number,
  body: ApiErrorBody | null,
  mode: ErrorMappingMode = "default",
): McpToolError {
  const apiCode = body?.error?.code;
  const apiMessage =
    body?.error?.message ?? `Request failed with status ${status}.`;
  const rawDetails = body?.error?.details;
  const detailCode = extractDetailCode(rawDetails);
  if (mode === "board" || mode === "board-import") {
    const { code } = pickBoardCode(status, apiCode, detailCode);
    const details = pickDetails(rawDetails, BOARD_DETAIL_KEYS);
    const unsupported =
      apiCode === undefined &&
      detailCode === undefined &&
      (status === 404 || status === 405 || status === 501);
    const routeUnsupported =
      mode === "board-import"
        ? BOARD_IMPORT_ROUTE_UNSUPPORTED
        : BOARD_ROUTE_UNSUPPORTED;
    return new McpToolError(
      code,
      apiMessage,
      unsupported ? routeUnsupported : boardRemediation(code, mode),
      details,
    );
  }
  const { code, source } = pickStructuredCode(status, apiCode, detailCode);
  const details = pickDetails(rawDetails, ACTIONABLE_DETAIL_KEYS);
  return new McpToolError(
    code,
    apiMessage,
    remediationFor(code, source, details),
    details,
  );
}

/** The MCP code plus the API machine code that decided it, if any. */
interface PickedCode {
  code: McpStructuredCode;
  source?: string;
}

function pickStructuredCode(
  status: number,
  apiCode: string | undefined,
  detailCode: string | undefined,
): PickedCode {
  const specific = lookupCode(DETAIL_FIRST_CODES, detailCode);
  if (specific) return { code: specific, source: detailCode };

  const explicit = apiCode ?? detailCode;
  const known =
    lookupCode(DETAIL_FIRST_CODES, explicit) ??
    lookupCode(ENVELOPE_FIRST_CODES, explicit);
  if (known) return { code: known, source: explicit };

  // Fallback by status code.
  if (status === 401) return { code: "AUTH_FAILED" };
  if (status === 403) return { code: "TOKEN_SCOPE_MISMATCH" };
  if (status === 404) return { code: "NOT_FOUND" };
  if (status === 409) return { code: "STALE_VERSION" };
  if (status === 422) return { code: "VALIDATION_ERROR" };
  if (status === 429) return { code: "RATE_LIMITED" };
  return { code: "INTERNAL_ERROR" };
}

function pickBoardCode(
  status: number,
  apiCode: string | undefined,
  detailCode: string | undefined,
): PickedCode {
  const specific =
    lookupCode(BOARD_DETAIL_CODES, detailCode) ??
    lookupCode(BOARD_DETAIL_CODES, apiCode);
  if (specific) return { code: specific, source: detailCode ?? apiCode };
  // A body without a known code (for example a proxy error page): a 400 is
  // still a refused argument, everything else keeps the shared fallback.
  if (status === 400) return { code: "VALIDATION_ERROR" };
  return pickStructuredCode(status, apiCode, detailCode);
}

function lookupCode(
  table: Readonly<Record<string, McpStructuredCode>>,
  code: string | undefined,
): McpStructuredCode | undefined {
  if (!code || !Object.hasOwn(table, code)) return undefined;
  return table[code];
}

function extractDetailCode(details: unknown): string | undefined {
  if (
    details &&
    typeof details === "object" &&
    "code" in details &&
    typeof (details as { code: unknown }).code === "string"
  ) {
    return (details as { code: string }).code;
  }
  return undefined;
}

function pickDetails(
  details: unknown,
  keys: readonly (ActionableDetailKey | BoardDetailKey)[],
): McpFailureDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const source = details as Record<string, unknown>;
  const out: McpFailureDetails = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function remediationFor(
  code: McpStructuredCode,
  source: string | undefined,
  details: McpFailureDetails | undefined,
): string {
  if (
    code === "SPEC_LOCKED" &&
    typeof details?.status === "string" &&
    Object.hasOwn(SPEC_LOCKED_BY_STATUS, details.status)
  ) {
    return SPEC_LOCKED_BY_STATUS[details.status];
  }
  if (code === "NOT_FOUND" && source === "SECTION_NOT_FOUND") {
    return details?.reason === "ANCHOR_STALE"
      ? SECTION_ANCHOR_STALE
      : SECTION_MISSING;
  }
  return REMEDIATIONS[code];
}

export function buildClientFailure(code: McpStructuredCode, message: string): McpFailure {
  return { code, message, remediation: REMEDIATIONS[code] };
}
