// MCP-side error mapping (per Kstonebase spec "mcp-server" §5 "Error mapping"
// and "mcp-open-question-management" §6). Translates Kstonebase API error
// envelopes into MCP error codes the agent can reason about, each carrying a
// short remediation string plus the API's actionable details.

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
  | "INTERNAL_ERROR";

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

export type McpFailureDetails = Partial<Record<ActionableDetailKey, unknown>>;

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
    "The specification is not an editable Draft. If it is Reviewed, call start_new_version first. If it is in Needs Review, a human must move it back to Draft in Kstonebase (start_new_version does not unlock Needs Review). If it is generating, wait for it to finish. Re-read before retrying.",
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
};

// SPEC_LOCKED next steps depend on the specification's status (open-question
// contract §4): only a Reviewed spec is unlocked by start_new_version.
const SPEC_LOCKED_BY_STATUS: Record<string, string> = {
  REVIEWED:
    "The specification is Reviewed. Call start_new_version to open a Draft, re-read it for the new version, then retry.",
  NEEDS_REVIEW:
    "The specification is in Needs Review. start_new_version does not unlock it: a human must move it back to Draft in Kstonebase. Ask the user, then re-read before retrying.",
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

/**
 * Map an HTTP response (status + parsed body) onto an `McpToolError`.
 * Specification and question codes are read from `error.details.code` first;
 * everything else resolves as it always has (envelope code, then
 * `details.code`, then the status code's standard meaning). Actionable
 * details (hint, reason, fields, status, sectionPath, from, to) travel with
 * the error so the agent can re-read and decide instead of retrying blindly.
 */
export function mapApiError(
  status: number,
  body: ApiErrorBody | null,
): McpToolError {
  const apiCode = body?.error?.code;
  const apiMessage =
    body?.error?.message ?? `Request failed with status ${status}.`;
  const rawDetails = body?.error?.details;
  const { code, source } = pickStructuredCode(
    status,
    apiCode,
    extractDetailCode(rawDetails),
  );
  const details = pickActionableDetails(rawDetails);
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

function pickActionableDetails(details: unknown): McpFailureDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const source = details as Record<string, unknown>;
  const out: McpFailureDetails = {};
  for (const key of ACTIONABLE_DETAIL_KEYS) {
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
