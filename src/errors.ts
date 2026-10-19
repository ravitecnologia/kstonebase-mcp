// MCP-side error mapping (per Kstonebase spec "mcp-server" §5 "Error mapping",
// "mcp-open-question-management" §6, "mcp-board-tools" §2.1,
// "workspace-agent-instructions" (frozen contract, PBI 176),
// "mcp-engineering-tools" ME6 (PBI 230) and "specification-authoring/
// protocol" T5 (frozen client contract v1, PBI 276)). Translates
// Kstonebase API error envelopes into MCP error codes the agent can reason
// about, each carrying a short remediation string plus the API's actionable
// details.

import {
  ENGINEERING_DETAIL_KEYS,
  ENGINEERING_ERROR_CODES,
  engineeringRemediation,
} from "./engineering-catalog.js";
import {
  LIBRARY_ERROR_CODES,
  LIBRARY_ERROR_TEXT,
  type LibraryErrorCode,
} from "./library-catalog.js";

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
  | "IMPORT_NOT_FOUND"
  // Effective Workspace instructions (MCP › features/workspace-agent-
  // instructions.md, frozen contract PBI 176; API frozen contract PBI 174).
  | "POLICY_STALE"
  | "POLICY_REVISION_REQUIRED"
  | "INVALID_POLICY_REVISION"
  | "POLICY_TARGET_REQUIRED"
  | "POLICY_UNSUPPORTED"
  // Engineering tools (MCP › mcp-engineering-tools.md ME6; API ›
  // agent-engineering-contract.md §3.3 and AE-I31). ENGINEERING_UNSUPPORTED
  // is raised here for a server without the engineering routes.
  | "ENGINEERING_UNSUPPORTED"
  | "ENGINEERING_UNAVAILABLE"
  | "ENGINEERING_DELEGATION_REQUIRED"
  | "ENGINEERING_CONSENT_REQUIRED"
  | "PROVIDER_CONSENT_REQUIRED"
  | "PROVIDER_PERMISSION_INSUFFICIENT"
  | "NOT_ALLOWED_BY_POLICY"
  | "PROVIDER_FEATURE_UNSUPPORTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "REPOSITORY_NOT_CONFIGURED"
  | "DELIVERY_NOT_CONFIGURED"
  | "REPOSITORY_CHANGED"
  | "REPOSITORY_ACCESS_DENIED"
  | "CONNECTION_REQUIRED"
  | "REVISION_NOT_FOUND"
  | "PATH_NOT_FOUND"
  | "PULL_REQUEST_NOT_FOUND"
  | "CI_RUN_NOT_FOUND"
  | "ENVIRONMENT_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_ARCHIVED"
  // Engineering evidence, assessment-save and reviewed-action tools (MCP ›
  // mcp-engineering-tools.md MT-I13). STALE_VERSION, IDEMPOTENCY_KEY_REUSED,
  // LINK_LIMIT_REACHED and ITEM_ARCHIVED are shared with other tools above.
  | "ACTION_CONFLICT"
  | "ACTION_STATE_CONFLICT"
  | "ACTION_ACTOR_REQUIRED"
  | "ACTION_NOT_FOUND"
  | "ACTION_STALE"
  | "ACTION_EXPIRED"
  | "HUMAN_CONFIRMATION_REQUIRED"
  | "LINK_NOT_FOUND"
  | "ARTIFACT_NOT_FOUND"
  | "DEPLOYMENT_NOT_FOUND"
  | "ASSESSMENT_NOT_FOUND"
  | "COMPLETION_NOT_ELIGIBLE"
  | "PULL_REQUEST_EXISTS"
  | "PULL_REQUEST_NOT_OPEN"
  | "PULL_REQUEST_DRAFT"
  | "PULL_REQUEST_NOT_MERGEABLE"
  | "INVALID_REFERENCE"
  // Specification authoring (MCP › specification-authoring/protocol.md
  // "Frozen client contract (v1)" T5; API › specification-authoring/
  // contracts.md §N). The API sends them in `details.code` on every tool.
  // PAYLOAD_TOO_LARGE is a 413 answer in the default and authoring modes;
  // AUTHORING_UNSUPPORTED is raised here for a server without the
  // authoring routes.
  | "BODY_HISTORY_VIOLATION"
  | "REVIEW_COVERAGE_INCOMPLETE"
  | "CONTENT_TOO_LARGE"
  | "INVALID_CONTENT"
  | "INVALID_PATH"
  | "PATH_CONFLICT"
  | "PATH_CASE_CONFLICT"
  | "INDEX_CONFLICT"
  | "INDEX_REQUIRED"
  | "SPEC_NOT_ARCHIVED"
  | "AUTHORING_REVISION_REQUIRED"
  | "AUTHORING_REVISION_STALE"
  | "AUTHORING_PLAN_STALE"
  | "AUTHORING_PLAN_INVALID"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "AUTHORING_UNAVAILABLE"
  | "INVALID_PLAN_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "CONTAINER_ARCHIVED"
  | "INVALID_TARGET"
  | "AUTHORING_UNSUPPORTED"
  // Workspace Library (MCP › features/mcp-library-tools.md §3, PBI 352; API ›
  // features/workspace-library.md §9). The API sends them in `details.code`.
  | LibraryErrorCode;

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

/** The `error.details` keys an engineering tool passes on (ME6). */
export type EngineeringDetailKey = (typeof ENGINEERING_DETAIL_KEYS)[number];

/**
 * The `error.details` keys passed on for the authoring codes (T5). `findings`
 * and `dependents` are rebuilt from their listed keys only, and every string
 * is clipped to MAX_DETAIL_STRING characters.
 */
const AUTHORING_DETAIL_KEYS = [
  "findings",
  "total",
  "truncated",
  "truncatedFindings",
  "remediation",
  "reason",
  "rule",
  "field",
  "path",
  "existingId",
  "existingPath",
  "folder",
  "dependentCount",
  "dependents",
  "currentRevision",
  "digest",
  "limitBytes",
  "sizeBytes",
  "status",
  "hint",
  "requested",
  "supported",
] as const;

export type AuthoringDetailKey = (typeof AUTHORING_DETAIL_KEYS)[number];

export type McpFailureDetails = Partial<
  Record<
    ActionableDetailKey | BoardDetailKey | EngineeringDetailKey | AuthoringDetailKey,
    unknown
  >
>;

/**
 * How an API error is mapped. "board" is used by the native Board tools only:
 * there the API's `details.code` is always the tool error code, credential
 * codes included (MCP › mcp-board-tools.md §2.1), and Board remediations and
 * details apply. "board-import" is the same mapping for the Board import
 * report reads (list_board_imports, read_board_import; spec §2.2), with
 * remediations worded for Owner-only reports. "engineering" is used by the
 * engineering tools (MCP › mcp-engineering-tools.md ME6): the API's
 * `details.code` is the tool code and the engineering remediations and
 * details apply. "engineering-write" is the same for the engineering write
 * tools (MT-I13), whose INTERNAL_ERROR says the change may have applied.
 * "authoring" is used by the authoring context and plan requests (T5): a
 * 404, 405 or 501 without the API error envelope is AUTHORING_UNSUPPORTED,
 * everything else maps as in "default". "default" keeps the existing
 * vocabulary for every other tool; its authoring codes (`details.code`
 * first) and 413 PAYLOAD_TOO_LARGE are shared with "authoring".
 */
export type ErrorMappingMode =
  | "default"
  | "authoring"
  | "board"
  | "board-import"
  | "engineering"
  | "engineering-write"
  | "library";

const isEngineeringMode = (mode: ErrorMappingMode): mode is "engineering" | "engineering-write" =>
  mode === "engineering" || mode === "engineering-write";

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

/** The catalog remediation of an engineering code without details. */
function engineeringText(code: McpStructuredCode): string {
  return engineeringRemediation(code) ?? "";
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
    "New Products always use the flexible document model. Omit specificationManagementType.",
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
  // Workspace instructions (frozen contract PBI 176): the same text in the
  // default and Board modes, and on the Kstonebase-hosted endpoint.
  POLICY_STALE:
    "The Workspace agent instructions changed. Call get_effective_instructions for this resource, review the new instructions with the user, then retry with the new expectedPolicyRevision. Never replay the write automatically.",
  POLICY_REVISION_REQUIRED:
    "This Workspace enforces its agent instructions. Call get_effective_instructions for this resource, follow the instructions, and pass its policyRevision as expectedPolicyRevision.",
  INVALID_POLICY_REVISION:
    "Pass the policyRevision exactly as returned by get_effective_instructions (wp1_…).",
  POLICY_TARGET_REQUIRED:
    "Pass exactly one of workspaceId, productId or specificationId.",
  POLICY_UNSUPPORTED:
    "This Kstonebase server cannot provide Workspace instructions. Do not assume Local mode; ask the user before acting on Workspace resources.",
  // Engineering tools: the shared catalog text (ME6), identical on every
  // transport. Codes reached only by engineering tools.
  ENGINEERING_UNSUPPORTED: engineeringText("ENGINEERING_UNSUPPORTED"),
  ENGINEERING_UNAVAILABLE: engineeringText("ENGINEERING_UNAVAILABLE"),
  ENGINEERING_DELEGATION_REQUIRED: engineeringText("ENGINEERING_DELEGATION_REQUIRED"),
  ENGINEERING_CONSENT_REQUIRED: engineeringText("ENGINEERING_CONSENT_REQUIRED"),
  PROVIDER_CONSENT_REQUIRED: engineeringText("PROVIDER_CONSENT_REQUIRED"),
  PROVIDER_PERMISSION_INSUFFICIENT: engineeringText("PROVIDER_PERMISSION_INSUFFICIENT"),
  NOT_ALLOWED_BY_POLICY: engineeringText("NOT_ALLOWED_BY_POLICY"),
  PROVIDER_FEATURE_UNSUPPORTED: engineeringText("PROVIDER_FEATURE_UNSUPPORTED"),
  PROVIDER_RATE_LIMITED: engineeringText("PROVIDER_RATE_LIMITED"),
  PROVIDER_UNAVAILABLE: engineeringText("PROVIDER_UNAVAILABLE"),
  REPOSITORY_NOT_CONFIGURED: engineeringText("REPOSITORY_NOT_CONFIGURED"),
  DELIVERY_NOT_CONFIGURED: engineeringText("DELIVERY_NOT_CONFIGURED"),
  REPOSITORY_CHANGED: engineeringText("REPOSITORY_CHANGED"),
  REPOSITORY_ACCESS_DENIED: engineeringText("REPOSITORY_ACCESS_DENIED"),
  CONNECTION_REQUIRED: engineeringText("CONNECTION_REQUIRED"),
  REVISION_NOT_FOUND: engineeringText("REVISION_NOT_FOUND"),
  PATH_NOT_FOUND: engineeringText("PATH_NOT_FOUND"),
  PULL_REQUEST_NOT_FOUND: engineeringText("PULL_REQUEST_NOT_FOUND"),
  CI_RUN_NOT_FOUND: engineeringText("CI_RUN_NOT_FOUND"),
  ENVIRONMENT_NOT_FOUND: engineeringText("ENVIRONMENT_NOT_FOUND"),
  STAGE_NOT_FOUND: engineeringText("STAGE_NOT_FOUND"),
  PRODUCT_NOT_FOUND: engineeringText("PRODUCT_NOT_FOUND"),
  PRODUCT_ARCHIVED: engineeringText("PRODUCT_ARCHIVED"),
  ACTION_CONFLICT: engineeringText("ACTION_CONFLICT"),
  ACTION_STATE_CONFLICT: engineeringText("ACTION_STATE_CONFLICT"),
  ACTION_ACTOR_REQUIRED: engineeringText("ACTION_ACTOR_REQUIRED"),
  ACTION_NOT_FOUND: engineeringText("ACTION_NOT_FOUND"),
  ACTION_STALE: engineeringText("ACTION_STALE"),
  ACTION_EXPIRED: engineeringText("ACTION_EXPIRED"),
  HUMAN_CONFIRMATION_REQUIRED: engineeringText("HUMAN_CONFIRMATION_REQUIRED"),
  LINK_NOT_FOUND: engineeringText("LINK_NOT_FOUND"),
  ARTIFACT_NOT_FOUND: engineeringText("ARTIFACT_NOT_FOUND"),
  DEPLOYMENT_NOT_FOUND: engineeringText("DEPLOYMENT_NOT_FOUND"),
  ASSESSMENT_NOT_FOUND: engineeringText("ASSESSMENT_NOT_FOUND"),
  COMPLETION_NOT_ELIGIBLE: engineeringText("COMPLETION_NOT_ELIGIBLE"),
  PULL_REQUEST_EXISTS: engineeringText("PULL_REQUEST_EXISTS"),
  PULL_REQUEST_NOT_OPEN: engineeringText("PULL_REQUEST_NOT_OPEN"),
  PULL_REQUEST_DRAFT: engineeringText("PULL_REQUEST_DRAFT"),
  PULL_REQUEST_NOT_MERGEABLE: engineeringText("PULL_REQUEST_NOT_MERGEABLE"),
  INVALID_REFERENCE: engineeringText("INVALID_REFERENCE"),
  // Specification authoring (frozen client contract v1, T5): the same
  // sentences in the package on every transport. The API's own hint and
  // remediation details travel unchanged next to them.
  BODY_HISTORY_VIOLATION:
    "Keep the body as consolidated current state: remove the dated change log or history section from the content and record those decisions with append_context or a changeNote. The findings name each line.",
  REVIEW_COVERAGE_INCOMPLETE:
    'Cover each listed rubric dimension with substantive text, an explicit "Not applicable: <reason>" line or a native open question or assumption, then request review again.',
  CONTENT_TOO_LARGE:
    "Split the subject into smaller, focused specifications linked from its folder index (limit 512 KiB).",
  INVALID_CONTENT:
    "Remove U+0000 (NUL) characters from the title, path, tags and content, then retry.",
  INVALID_PATH:
    'Use a relative path without "." or ".." segments, control characters or an index.md folder segment, with at most 16 segments of 200 bytes; details.rule and details.hint name the problem.',
  PATH_CONFLICT:
    "A specification already exists at this path (details.existingId): update or reuse it, or choose another path.",
  PATH_CASE_CONFLICT:
    "The path differs from an existing path only by letter case (details.existingPath): reuse the existing spelling.",
  INDEX_CONFLICT:
    "Another change created this folder index at the same time: retry, and the existing index will be reused.",
  INDEX_REQUIRED:
    "This folder index is required by the active specifications in details.dependents: archive, delete or move them first, or keep the index.",
  SPEC_NOT_ARCHIVED:
    "Only an archived specification can be restored; this one is already active, so read it again.",
  AUTHORING_REVISION_REQUIRED:
    "Pass the authoringRevision from read_authoring_context or from the prepared plan.",
  AUTHORING_REVISION_STALE:
    "The Product's authoring settings or ancestor indexes changed (details.currentRevision): call read_authoring_context again, re-read the indexes and prepare a new plan.",
  AUTHORING_PLAN_STALE:
    "Something the plan depends on changed and nothing was applied: re-read the affected specifications, prepare and validate the plan again, then apply it with a new idempotencyKey.",
  AUTHORING_PLAN_INVALID:
    "The plan has blocking findings and nothing was applied: fix the operations named in details.findings, validate again, then apply.",
  IDEMPOTENCY_KEY_CONFLICT:
    "This idempotencyKey was already used for a different request: use a new key for a new plan, or resend the exact original request to read its outcome.",
  AUTHORING_UNAVAILABLE:
    "Authoring plans are not enabled on this server: create or update one specification at a time with the single-specification tools.",
  INVALID_PLAN_REQUEST:
    "The plan request has the wrong shape (details.field, details.rule): correct that field and send the request again.",
  PAYLOAD_TOO_LARGE:
    "The request is too large: split the plan into smaller plans (at most 4 MiB) or the content into smaller, focused specifications.",
  CONTAINER_ARCHIVED:
    "The Product or Workspace is archived: restore it before changing its specifications.",
  INVALID_TARGET:
    "Pass exactly one target: a workspaceId, productId or specificationId.",
  AUTHORING_UNSUPPORTED:
    "This Kstonebase server does not support authoring context or plans yet. Use the single-specification tools and tell the user the authoring rules could not be checked.",
  LIBRARY_APPROVAL_REQUIRED: LIBRARY_ERROR_TEXT.LIBRARY_APPROVAL_REQUIRED.remediation,
  LIBRARY_CONTENT_TOO_LARGE: LIBRARY_ERROR_TEXT.LIBRARY_CONTENT_TOO_LARGE.remediation,
  LIBRARY_NOT_SECRET: LIBRARY_ERROR_TEXT.LIBRARY_NOT_SECRET.remediation,
  LIBRARY_TOO_MANY_PENDING: LIBRARY_ERROR_TEXT.LIBRARY_TOO_MANY_PENDING.remediation,
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

// Workspace-instruction codes (API frozen contract PBI 174): 409 CONFLICT +
// POLICY_STALE, 428 PRECONDITION_REQUIRED + POLICY_REVISION_REQUIRED and 422
// VALIDATION_ERROR + INVALID_POLICY_REVISION arrive in `details.code`, on
// every write route (specification, question, Product and Board writes), so
// they are read first in the default mode and in both Board modes.
const POLICY_CODES: Readonly<Record<string, McpStructuredCode>> = {
  POLICY_STALE: "POLICY_STALE",
  POLICY_REVISION_REQUIRED: "POLICY_REVISION_REQUIRED",
  INVALID_POLICY_REVISION: "INVALID_POLICY_REVISION",
  POLICY_TARGET_REQUIRED: "POLICY_TARGET_REQUIRED",
  POLICY_UNSUPPORTED: "POLICY_UNSUPPORTED",
};

// Specification authoring codes (T5): the API sends them in `details.code`
// under a generic envelope (VALIDATION_ERROR, CONFLICT, NOT_FOUND,
// PRECONDITION_REQUIRED…), so they win on every default-mode tool — a
// PATH_CONFLICT on create_free_specification is PATH_CONFLICT, not the
// STALE_VERSION its 409 status would suggest.
const AUTHORING_CODES: Readonly<Record<string, McpStructuredCode>> = {
  BODY_HISTORY_VIOLATION: "BODY_HISTORY_VIOLATION",
  REVIEW_COVERAGE_INCOMPLETE: "REVIEW_COVERAGE_INCOMPLETE",
  CONTENT_TOO_LARGE: "CONTENT_TOO_LARGE",
  INVALID_CONTENT: "INVALID_CONTENT",
  INVALID_PATH: "INVALID_PATH",
  PATH_CONFLICT: "PATH_CONFLICT",
  PATH_CASE_CONFLICT: "PATH_CASE_CONFLICT",
  INDEX_CONFLICT: "INDEX_CONFLICT",
  INDEX_REQUIRED: "INDEX_REQUIRED",
  SPEC_NOT_ARCHIVED: "SPEC_NOT_ARCHIVED",
  AUTHORING_REVISION_REQUIRED: "AUTHORING_REVISION_REQUIRED",
  AUTHORING_REVISION_STALE: "AUTHORING_REVISION_STALE",
  AUTHORING_PLAN_STALE: "AUTHORING_PLAN_STALE",
  AUTHORING_PLAN_INVALID: "AUTHORING_PLAN_INVALID",
  IDEMPOTENCY_KEY_CONFLICT: "IDEMPOTENCY_KEY_CONFLICT",
  AUTHORING_UNAVAILABLE: "AUTHORING_UNAVAILABLE",
  INVALID_PLAN_REQUEST: "INVALID_PLAN_REQUEST",
  CONTAINER_ARCHIVED: "CONTAINER_ARCHIVED",
  INVALID_TARGET: "INVALID_TARGET",
};

// Specification and question codes. The API sends them in `details.code`
// under a generic envelope (CONFLICT, BAD_REQUEST, NOT_FOUND, SPEC_LOCKED…),
// so `details.code` is consulted first for these.
const DETAIL_FIRST_CODES: Readonly<Record<string, McpStructuredCode>> = {
  SPEC_LOCKED: "SPEC_LOCKED",
  SPEC_ARCHIVED: "SPEC_ARCHIVED",
  OPEN_QUESTIONS_PRESENT: "OPEN_QUESTIONS_PRESENT",
  PRODUCT_TYPE_MISMATCH: "PRODUCT_TYPE_MISMATCH",
  // create_product's refusal of an explicit legacy management type (PBI 271)
  // arrives under BAD_REQUEST; nothing was created, so it must not read as
  // an INTERNAL_ERROR that "may already have been applied".
  PRODUCT_TYPE_UNSUPPORTED: "PRODUCT_TYPE_UNSUPPORTED",
  STALE_VERSION: "STALE_VERSION",
  STALE_QUESTION: "STALE_QUESTION",
  MARKER_NOT_FOUND: "MARKER_NOT_FOUND",
  MARKER_AMBIGUOUS: "MARKER_AMBIGUOUS",
  SECTION_NOT_FOUND: "NOT_FOUND",
  SECTION_AMBIGUOUS: "SECTION_AMBIGUOUS",
  ANSWER_REQUIRED: "ANSWER_REQUIRED",
  INVALID_TRANSITION: "INVALID_TRANSITION",
  ...AUTHORING_CODES,
  ...POLICY_CODES,
};

// The codes whose details use the authoring allowlist (T5): the authoring
// codes themselves, the client-side AUTHORING_UNSUPPORTED and
// PAYLOAD_TOO_LARGE get exactly AUTHORING_DETAIL_KEYS; the codes T5 shares
// with older contracts (SPEC_LOCKED, SPEC_ARCHIVED, PRODUCT_TYPE_*, policy)
// keep their existing keys and gain the authoring ones.
const AUTHORING_DETAIL_CODES: ReadonlySet<McpStructuredCode> = new Set<McpStructuredCode>([
  ...Object.values(AUTHORING_CODES),
  "PAYLOAD_TOO_LARGE",
  "AUTHORING_UNSUPPORTED",
]);

const SHARED_AUTHORING_DETAIL_CODES: ReadonlySet<McpStructuredCode> = new Set<McpStructuredCode>([
  "SPEC_LOCKED",
  "SPEC_ARCHIVED",
  "PRODUCT_TYPE_MISMATCH",
  "PRODUCT_TYPE_UNSUPPORTED",
  ...Object.values(POLICY_CODES),
]);

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

/** The remediation a Board tool (or, in "board-import" mode, an import report tool; in "engineering" / "engineering-write" mode, an engineering read / write tool) reports for `code`. */
export function boardRemediation(
  code: McpStructuredCode,
  mode: ErrorMappingMode = "board",
): string {
  if (isEngineeringMode(mode)) {
    return engineeringRemediation(code, undefined, mode === "engineering-write") ?? REMEDIATIONS[code];
  }
  const forImport =
    mode === "board-import" ? BOARD_IMPORT_REMEDIATIONS[code] : undefined;
  return forImport ?? BOARD_REMEDIATIONS[code] ?? REMEDIATIONS[code];
}

// Engineering refusals carry their specific code in `details.code` under the
// status envelope (BAD_REQUEST, FORBIDDEN, NOT_FOUND, CONFLICT,
// UNPROCESSABLE_ENTITY, RATE_LIMITED, BAD_GATEWAY…). In "engineering" mode
// that code is the tool error code (ME6), credential refusals included.
const ENGINEERING_DETAIL_CODES: Readonly<Record<string, McpStructuredCode>> = {
  ...Object.fromEntries(
    [...ENGINEERING_ERROR_CODES].map((code) => [code, code as McpStructuredCode]),
  ),
  AUTH_REQUIRED: "AUTH_FAILED",
  AUTH_FAILED: "AUTH_FAILED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  TOKEN_REVOKED: "TOKEN_REVOKED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  ...POLICY_CODES,
};

function pickEngineeringCode(
  status: number,
  apiCode: string | undefined,
  detailCode: string | undefined,
  write: boolean,
): McpStructuredCode {
  const specific =
    lookupCode(ENGINEERING_DETAIL_CODES, detailCode) ??
    lookupCode(ENGINEERING_DETAIL_CODES, apiCode);
  if (specific) return specific;
  if (status === 400) return "VALIDATION_ERROR";
  // A write answered by a 5xx without a Kstonebase engineering code (a
  // gateway timeout, a proxy error page) may have applied (MT-I13).
  if (write && status >= 500) return "INTERNAL_ERROR";
  if (status === 502 || status === 503 || status === 504) return "PROVIDER_UNAVAILABLE";
  return pickStructuredCode(status, apiCode, detailCode).code;
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
  ...POLICY_CODES,
};

/**
 * Map an HTTP response (status + parsed body) onto an `McpToolError`.
 * Specification and question codes are read from `error.details.code` first;
 * everything else resolves as it always has (envelope code, then
 * `details.code`, then the status code's standard meaning). Actionable
 * details (hint, reason, fields, status, sectionPath, from, to) travel with
 * the error so the agent can re-read and decide instead of retrying blindly.
 * The specification authoring codes (T5) are read from `details.code` first
 * too, carry the authoring detail allowlist, and a 413 is PAYLOAD_TOO_LARGE;
 * "authoring" mode adds AUTHORING_UNSUPPORTED for a route without the API
 * error envelope.
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
  if (isEngineeringMode(mode)) {
    // A server without the engineering routes (or without this method on
    // one) answers a 404, 405 or 501 without any Kstonebase error code
    // (ME1): nothing was verified or changed.
    const unsupported =
      apiCode === undefined &&
      detailCode === undefined &&
      (status === 404 || status === 405 || status === 501);
    const code = unsupported
      ? "ENGINEERING_UNSUPPORTED"
      : pickEngineeringCode(status, apiCode, detailCode, mode === "engineering-write");
    const details = pickDetails(rawDetails, ENGINEERING_DETAIL_KEYS);
    return new McpToolError(
      code,
      unsupported
        ? "This Kstonebase server does not provide the engineering tools."
        : apiMessage,
      engineeringRemediation(code, details, mode === "engineering-write") ?? REMEDIATIONS[code],
      details,
    );
  }
  if (mode === "library") {
    return mapLibraryError(status, apiCode, detailCode, apiMessage, rawDetails);
  }
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
  if (mode === "authoring") {
    // An older API or an older Website proxy answers an authoring route
    // without any Kstonebase error envelope (an HTML or plain-text 404,
    // a 405 or a 501): nothing was checked or written.
    const unsupported =
      apiCode === undefined &&
      detailCode === undefined &&
      (status === 404 || status === 405 || status === 501);
    if (unsupported) {
      return new McpToolError(
        "AUTHORING_UNSUPPORTED",
        "This Kstonebase server does not provide authoring context or plans.",
        REMEDIATIONS.AUTHORING_UNSUPPORTED,
      );
    }
  }
  // In the default and authoring modes a 413 is PAYLOAD_TOO_LARGE whoever
  // answered it (the API or the Website's request bound), T5; the Board and
  // engineering modes above keep their own mapping.
  const { code, source } =
    status === 413
      ? { code: "PAYLOAD_TOO_LARGE" as const, source: detailCode ?? apiCode }
      : pickStructuredCode(status, apiCode, detailCode);
  const details = detailsFor(code, rawDetails);
  return new McpToolError(
    code,
    apiMessage,
    remediationFor(code, source, details),
    details,
  );
}

/** The `error.details` keys a Library tool passes on (validation only). */
const LIBRARY_DETAIL_KEYS = ["field", "problem", "hint"] as const;

/**
 * "library" mode (MCP › features/mcp-library-tools.md §3): a Library
 * `details.code` (or envelope code) is the tool code with the spec's message
 * and remediation; any 404 is "not found or outside this credential's
 * scope", whoever answered it (a Product-only credential, a request of
 * another credential, a server without the Library); everything else keeps
 * the shared mapping.
 */
function mapLibraryError(
  status: number,
  apiCode: string | undefined,
  detailCode: string | undefined,
  apiMessage: string,
  rawDetails: unknown,
): McpToolError {
  const library = [detailCode, apiCode].find(
    (c): c is LibraryErrorCode => c !== undefined && (LIBRARY_ERROR_CODES as readonly string[]).includes(c),
  );
  if (library) {
    const text = LIBRARY_ERROR_TEXT[library];
    return new McpToolError(library, text.message, text.remediation);
  }
  // A credential refusal in `details.code` wins over its FORBIDDEN envelope
  // (as on the Board tools), so a read-only token asking for access hears
  // TOKEN_SCOPE_INSUFFICIENT.
  const credential = lookupCode(ENVELOPE_FIRST_CODES, detailCode);
  if (credential && status !== 404) {
    return new McpToolError(credential, apiMessage, REMEDIATIONS[credential]);
  }
  if (status === 404 || detailCode === "NOT_FOUND" || apiCode === "NOT_FOUND") {
    return new McpToolError(
      "NOT_FOUND",
      LIBRARY_ERROR_TEXT.NOT_FOUND.message,
      LIBRARY_ERROR_TEXT.NOT_FOUND.remediation,
    );
  }
  if (detailCode === "VALIDATION_ERROR" || apiCode === "VALIDATION_ERROR" || status === 400 || status === 422) {
    return new McpToolError(
      "VALIDATION_ERROR",
      apiMessage,
      REMEDIATIONS.VALIDATION_ERROR,
      pickDetails(rawDetails, LIBRARY_DETAIL_KEYS),
    );
  }
  const { code, source } = pickStructuredCode(status, apiCode, detailCode);
  const details = pickDetails(rawDetails, ACTIONABLE_DETAIL_KEYS);
  return new McpToolError(code, apiMessage, remediationFor(code, source, details), details);
}

/** The details a default- or authoring-mode failure passes on for `code`. */
function detailsFor(code: McpStructuredCode, raw: unknown): McpFailureDetails | undefined {
  if (AUTHORING_DETAIL_CODES.has(code)) return pickAuthoringDetails(raw, false);
  if (SHARED_AUTHORING_DETAIL_CODES.has(code)) return pickAuthoringDetails(raw, true);
  return pickDetails(raw, ACTIONABLE_DETAIL_KEYS);
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
  keys: readonly (ActionableDetailKey | BoardDetailKey | EngineeringDetailKey | AuthoringDetailKey)[],
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

// Authoring detail bounds (T5), the same rules as the Kstonebase-hosted
// registry's authoringErrorDetails.
const MAX_DETAIL_STRING = 2_000;
const MAX_DETAIL_FINDINGS = 50;
const MAX_DETAIL_DEPENDENTS = 5;
const MAX_DETAIL_ARRAY = 50;
const FINDING_KEYS = [
  "ruleId",
  "severity",
  "message",
  "operation",
  "path",
  "subject",
  "excerpt",
  "dimension",
  "remediation",
] as const;

// The existing actionable keys the shared codes keep unchanged; the keys
// they share with AUTHORING_DETAIL_KEYS follow the authoring rules.
const EXISTING_ONLY_DETAIL_KEYS = ACTIONABLE_DETAIL_KEYS.filter(
  (key) => !(AUTHORING_DETAIL_KEYS as readonly string[]).includes(key),
);

type DetailPrimitive = string | number | boolean;

/**
 * The authoring allowlist (T5), sanitized: `findings` keep at most 50
 * objects with only their listed keys as primitives (`location` as
 * `{line, heading}`: a finite number and a string), `dependents` at most 5
 * `{id, path}` strings (empty ones dropped), every other value only as a
 * primitive or an array of at most 50 primitives, and every string clipped
 * to 2,000 code points. With `withExisting`, the existing actionable keys
 * of the shared codes that are not authoring keys are kept as before.
 */
function pickAuthoringDetails(
  details: unknown,
  withExisting: boolean,
): McpFailureDetails | undefined {
  if (!isPlainRecord(details)) return undefined;
  const out: McpFailureDetails = withExisting
    ? { ...pickDetails(details, EXISTING_ONLY_DETAIL_KEYS) }
    : {};
  for (const key of AUTHORING_DETAIL_KEYS) {
    const value = details[key];
    if (key === "findings") {
      if (Array.isArray(value)) {
        out.findings = value.filter(isPlainRecord).slice(0, MAX_DETAIL_FINDINGS).map(sanitizeFinding);
      }
      continue;
    }
    if (key === "dependents") {
      if (Array.isArray(value)) {
        out.dependents = value
          .filter(isPlainRecord)
          .slice(0, MAX_DETAIL_DEPENDENTS)
          .map(sanitizeDependent)
          .filter((dependent): dependent is Record<string, unknown> => dependent !== undefined);
      }
      continue;
    }
    const single = detailPrimitive(value);
    if (single !== undefined) {
      out[key] = single;
    } else if (Array.isArray(value) && value.every((item) => detailPrimitive(item) !== undefined)) {
      out[key] = value.slice(0, MAX_DETAIL_ARRAY).map((item) => detailPrimitive(item) as DetailPrimitive);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeFinding(entry: Record<string, unknown>): Record<string, unknown> {
  const finding: Record<string, unknown> = {};
  for (const key of FINDING_KEYS) {
    const value = detailPrimitive(entry[key]);
    if (value !== undefined) finding[key] = value;
    // location keeps its place after subject, as the API orders it.
    if (key === "subject" && isPlainRecord(entry.location)) {
      const location: Record<string, unknown> = {};
      const { line, heading } = entry.location;
      if (typeof line === "number" && Number.isFinite(line)) location.line = line;
      if (typeof heading === "string") location.heading = clipString(heading);
      finding.location = location;
    }
  }
  return finding;
}

function sanitizeDependent(entry: Record<string, unknown>): Record<string, unknown> | undefined {
  const dependent: Record<string, unknown> = {};
  if (typeof entry.id === "string") dependent.id = clipString(entry.id);
  if (typeof entry.path === "string") dependent.path = clipString(entry.path);
  return Object.keys(dependent).length > 0 ? dependent : undefined;
}

/** A string (clipped), a boolean or a finite number; anything else is dropped. */
function detailPrimitive(value: unknown): DetailPrimitive | undefined {
  if (typeof value === "string") return clipString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function clipString(text: string): string {
  if (text.length <= MAX_DETAIL_STRING) return text;
  // Count code points, so a surrogate pair is never split.
  const points = Array.from(text);
  return points.length <= MAX_DETAIL_STRING ? text : points.slice(0, MAX_DETAIL_STRING).join("");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** A locally raised tool error carrying the code's default remediation. */
export function toolError(
  code: McpStructuredCode,
  message: string,
  details?: McpFailureDetails,
): McpToolError {
  return new McpToolError(code, message, REMEDIATIONS[code], details);
}
