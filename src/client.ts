// Kstonebase HTTP API client. Wraps the /api/mcp/* surface so tool
// handlers stay focused on argument shaping. Every outbound request carries
// `Authorization: Bearer kstonebase_pat_…`; no other auth artifacts are sent
// (per Kstonebase spec "mcp-server" §5 "Auth header"). Writes add
// `X-Kstonebase-Policy-Revision` only when the agent passed an
// expectedPolicyRevision (MCP › features/workspace-agent-instructions.md,
// frozen contract PBI 176).

import {
  McpToolError,
  boardRemediation,
  mapApiError,
  toolError,
  type ApiErrorBody,
  type ErrorMappingMode,
} from "./errors.js";
import {
  POLICY_REVISION_HEADER,
  type AgentPolicyResponse,
  type PolicyTarget,
} from "./policy.js";

export interface ClientOptions {
  apiUrl: string;
  token: string;
  /** Test override — replaces global fetch. */
  fetcher?: typeof fetch;
}

export interface ListSpecificationsQuery {
  type?: string;
  status?: string;
  folder?: string;
  tags?: string[];
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ReadSpecificationQuery {
  format?: "raw" | "rendered";
  /** Pass through to honour `If-None-Match` on the resource layer. */
  ifNoneMatch?: string;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  includeArchived?: boolean;
}

export interface ListOpenQuestionsQuery {
  includeResolved?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Open-question DTOs (Kstonebase MCP spec "mcp-open-question-management" §4
// and its implementation-contract change entry). The client never reshapes
// these: tools pass the API's JSON through unchanged.
// ──────────────────────────────────────────────────────────────────────────

export type OpenQuestionKind = "QUESTION" | "ASSUMPTION";

export type OpenQuestionStatus = "OPEN" | "RESOLVED" | "DISMISSED";

/** One question or assumption (list items and the `question` field). */
export interface OpenQuestion {
  id: string;
  specificationId: string;
  kind: OpenQuestionKind;
  body: string;
  answer: string | null;
  status: OpenQuestionStatus;
  /** Line number (as a string) of the heading the item lives under; null = before the first heading. */
  anchor: string | null;
  resolvedAt: string | null;
  createdAt: string;
  /** Send back verbatim as `expectedUpdatedAt`; never reformat it. */
  updatedAt: string;
}

/** Specification state returned next to every question result. */
export interface OpenQuestionSpecMeta {
  id: string;
  /** OCC token for the next write (`version` argument). */
  version: number;
  approvedVersion: number;
  status: string;
  openQuestionsCount: number;
}

/**
 * List item. `specificationId` and `resolvedAt` are additive fields, so they
 * are optional here: API builds that predate the open-question CRUD contract
 * do not send them.
 */
export type OpenQuestionListItem = Omit<
  OpenQuestion,
  "specificationId" | "resolvedAt"
> &
  Partial<Pick<OpenQuestion, "specificationId" | "resolvedAt">>;

export interface OpenQuestionList {
  /** Ordered by createdAt, oldest first. */
  items: OpenQuestionListItem[];
  /** Additive; absent on API builds that predate the open-question CRUD contract. */
  spec?: OpenQuestionSpecMeta;
}

/** Result of read, create and update. */
export interface OpenQuestionResult {
  question: OpenQuestion;
  spec: OpenQuestionSpecMeta;
}

export interface DeletedOpenQuestionResult {
  deletedQuestionId: string;
  spec: OpenQuestionSpecMeta;
}

export interface CreateOpenQuestionInput {
  /** Current specification version (OCC token). */
  version: number;
  body: string;
  /** Defaults to QUESTION on the API side when omitted. */
  kind?: OpenQuestionKind;
  /** Omitted or null = end of the document. */
  sectionPath?: string | null;
}

export interface UpdateOpenQuestionInput {
  /** Current specification version (OCC token). */
  version: number;
  /** The item's `updatedAt`, exactly as returned by the latest read. */
  expectedUpdatedAt: string;
  body?: string;
  /** Omitted = keep the location; null = move to the end of the document. */
  sectionPath?: string | null;
  /** Omitted = keep the draft answer; null = clear it. */
  answer?: string | null;
  status?: OpenQuestionStatus;
}

export interface DeleteOpenQuestionInput {
  version: number;
  expectedUpdatedAt: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Native Board inputs (Kstonebase API › features/workspace-board.md §9 and
// MCP › mcp-board-tools.md §2.1). Results are the API DTOs (Board, ItemPage,
// ItemDetail, NotesPage, {item, replayed}, {note, replayed}); the client
// passes them through unchanged, so they are typed as `unknown` here.
// ──────────────────────────────────────────────────────────────────────────

export type BoardItemType = "epic" | "feature" | "pbi";

export type BoardItemState = "to_do" | "doing" | "done";

export interface ListBoardItemsQuery {
  type?: BoardItemType;
  state?: BoardItemState;
  parentId?: string;
  /** A Product id, or "none" for Workspace-wide items. */
  productId?: string;
  /** A user id, or "none" for unassigned items. */
  assigneeId?: string;
  priority?: number;
  tag?: string;
  /** Sent as `q`: title substring, or `#12` / `12` for a display number. */
  query?: string;
  /** false (the API default) = active only; true = archived only. */
  archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export interface CreateBoardItemInput {
  type: BoardItemType;
  parentId?: string;
  title: string;
  description?: string;
  priority?: number;
  tags?: string[];
  assigneeId?: string;
  productId?: string;
  acceptanceCriteria?: string;
  implementationPrompt?: string;
  /** Sent exactly as given; the package never generates or replaces it. */
  idempotencyKey: string;
}

export interface UpdateBoardItemInput {
  expectedVersion: number;
  title?: string;
  description?: string;
  priority?: number;
  tags?: string[];
  /** null clears the assignee. */
  assigneeId?: string | null;
  /** null clears the Product. */
  productId?: string | null;
  acceptanceCriteria?: string;
  implementationPrompt?: string;
  state?: BoardItemState;
  parentId?: string;
}

export interface AppendBoardItemNoteInput {
  body: string;
  /** Sent exactly as given; the package never generates or replaces it. */
  idempotencyKey: string;
}

// Board import reports (API › features/azure-devops-board-import.md §8.8;
// MCP › mcp-board-tools.md §2.2). Read-only and Workspace-Owner-only; the
// results (`RunPage`, `RunDetail`) are passed through unchanged.

export type BoardImportPlan =
  | "import"
  | "already_imported"
  | "unsupported"
  | "excluded"
  | "blocked";

export type BoardImportOutcome =
  | "pending"
  | "imported"
  | "already_imported"
  | "skipped"
  | "blocked"
  | "failed";

export interface ReadBoardImportQuery extends PageQuery {
  /** Only the staged items with this plan decision. */
  plan?: BoardImportPlan;
  /** Only the staged items with this execution outcome. */
  outcome?: BoardImportOutcome;
}

// ──────────────────────────────────────────────────────────────────────────
// Specification authoring (MCP › specification-authoring/protocol.md
// "Frozen client contract (v1)" T1–T3; API › specification-authoring/
// contracts.md). The API decodes plan requests strictly and refuses unknown
// fields, so the client forwards exactly these fields; results (the context,
// `{valid, plan, findings}`, the apply outcome) are passed through unchanged.
// ──────────────────────────────────────────────────────────────────────────

export interface AuthoringContainerRef {
  type: "product" | "workspace";
  id: string;
}

export interface AuthoringSubject {
  key: string;
  title: string;
  /** "" is the container root. */
  folder: string;
}

export type AuthoringOperation =
  | {
      action: "create";
      subject: string;
      path: string;
      title: string;
      /** Required; "" is an empty document. */
      content: string;
      tags?: string[];
    }
  | {
      action: "update";
      subject: string;
      specificationId: string;
      expectedVersion: number;
      content: string;
      changeNote?: string;
    }
  | {
      action: "reuse";
      subject: string;
      specificationId: string;
      expectedVersion: number;
    };

export interface AuthoringIndexContent {
  path: string;
  content: string;
}

/** prepare: authoringRevision is optional. */
export interface AuthoringPlanInput {
  container: AuthoringContainerRef;
  authoringRevision?: string;
  subjects: AuthoringSubject[];
  operations: AuthoringOperation[];
  indexContent?: AuthoringIndexContent[];
}

/** validate: the prepare request with its authoringRevision and, optionally, the planDigest. */
export interface ValidateAuthoringPlanInput extends AuthoringPlanInput {
  authoringRevision: string;
  planDigest?: string;
}

/** apply: the validated request with its planDigest and an idempotencyKey (body only). */
export interface ApplyAuthoringPlanInput extends ValidateAuthoringPlanInput {
  planDigest: string;
  /** Sent exactly as given; the package never generates or replaces it. */
  idempotencyKey: string;
}

/**
 * Options every write method accepts. `policyRevision` is the agent's
 * expectedPolicyRevision: sent as the `X-Kstonebase-Policy-Revision` header,
 * never in the body, and no header at all when it is absent.
 */
export interface WriteOptions {
  policyRevision?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Workspace Library DTOs (frozen Epic 340 contract §4; API ›
// features/workspace-library.md §9). Results are passed through unchanged.
// ──────────────────────────────────────────────────────────────────────────

export interface ListLibraryQuery {
  folderId?: string;
  cursor?: string;
  limit?: number;
}

export interface McpLibraryFile {
  id: string;
  workspaceId: string;
  folderId: string | null;
  folderPath: string;
  name: string;
  kind: "image" | "video" | "audio";
  contentType: string;
  size: number;
  exposure: "common" | "secret";
  createdAt: string;
  updatedAt: string;
  /** Display name or null; only on read_library_file. */
  uploadedBy?: string | null;
}

export interface McpLibraryFolder {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpLibraryListing {
  workspaceId: string;
  folder: McpLibraryFolder | null;
  breadcrumbs: Array<{ id: string; name: string }>;
  folders: McpLibraryFolder[];
  files: McpLibraryFile[];
  total: number;
  nextCursor: string | null;
}

export interface McpLibraryLink {
  url: string;
  expiresAt: string;
}

export interface McpLibraryContent {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  base64: string;
}

export interface McpLibraryAccessRequest {
  requestId: string;
  fileId: string;
  status: "pending";
  expiresAt: string;
  approvalUrl: string;
}

export interface McpLibraryAccessStatus {
  requestId: string;
  fileId: string;
  status: "pending" | "approved" | "rejected" | "expired" | "redeemed" | "revoked";
  expiresAt: string;
  /** The one-time redeem URL; only when approved and unexpired. */
  url?: string;
}

export interface AgentPolicyQuery {
  /** Ask the resolver to hide enabled text (`instructions=omit`). */
  omitInstructions?: boolean;
}

export interface ApiResponse<T> {
  body: T;
  etag: string | null;
  status: number;
}

export interface NotModified {
  notModified: true;
  etag: string;
  status: 304;
}

export class KstonebaseClient {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  // ────────────────────────────────────────────────────────────────────
  // Read endpoints
  // ────────────────────────────────────────────────────────────────────

  listProducts(
    options: { workspaceId?: string; orphan?: boolean } = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (options.workspaceId) params.set("workspaceId", options.workspaceId);
    if (options.orphan) params.set("orphan", "true");
    const qs = params.toString();
    return this.getJson(`/api/mcp/products${qs ? `?${qs}` : ""}`);
  }

  listWorkspaces(): Promise<ApiResponse<unknown>> {
    return this.getJson("/api/mcp/workspaces");
  }

  readProduct(productId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(`/api/mcp/products/${encodeURIComponent(productId)}`);
  }

  readWorkspace(workspaceId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}`,
    );
  }

  listSpecifications(
    productId: string,
    query: ListSpecificationsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.status) params.set("status", query.status);
    if (query.folder) params.set("folder", query.folder);
    if (query.query) params.set("query", query.query);
    if (query.cursor) params.set("cursor", query.cursor);
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.tags) {
      for (const t of query.tags) params.append("tag", t);
    }
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications${qs ? `?${qs}` : ""}`,
    );
  }

  searchSpecifications(
    productId: string,
    query: SearchQuery,
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ query: query.query });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.includeArchived) {
      params.set("includeArchived", "true");
    }
    return this.getJson(
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications/search?${params.toString()}`,
    );
  }

  /**
   * Phase 4: Workspace-scoped specification list. Calls the MCP workspace
   * route which enforces workspace ownership and Free-management semantics.
   */
  listSpecificationsForWorkspace(
    workspaceId: string,
    query: ListSpecificationsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams();
    if (query.type) params.set("type", query.type);
    if (query.status) params.set("status", query.status);
    if (query.folder) params.set("folder", query.folder);
    if (query.query) params.set("query", query.query);
    if (query.cursor) params.set("cursor", query.cursor);
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.tags) {
      for (const t of query.tags) params.append("tag", t);
    }
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/specifications${qs ? `?${qs}` : ""}`,
    );
  }

  /**
   * Phase 4: cross-scope search. The server fans out to the Workspace's
   * own specs and to every member Product, then merges and scores.
   */
  searchSpecificationsForWorkspace(
    workspaceId: string,
    query: SearchQuery,
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ query: query.query });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    if (query.includeArchived) {
      params.set("includeArchived", "true");
    }
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/specifications/search?${params.toString()}`,
    );
  }

  readSpecification(
    specId: string,
    query: ReadSpecificationQuery = {},
  ): Promise<ApiResponse<unknown> | NotModified> {
    const params = new URLSearchParams();
    if (query.format) params.set("format", query.format);
    const qs = params.toString();
    return this.get(
      `/api/mcp/specifications/${encodeURIComponent(specId)}${qs ? `?${qs}` : ""}`,
      query.ifNoneMatch,
    );
  }

  listSpecificationVersions(specId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/versions`,
    );
  }

  readSpecificationVersion(
    specId: string,
    revisionId: string,
    ifNoneMatch?: string,
  ): Promise<ApiResponse<unknown> | NotModified> {
    return this.get(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/versions/${encodeURIComponent(revisionId)}`,
      ifNoneMatch,
    );
  }

  listSpecificationChanges(specId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/changes`,
    );
  }

  readSpecificationChange(
    specId: string,
    changeId: string,
    ifNoneMatch?: string,
  ): Promise<ApiResponse<unknown> | NotModified> {
    return this.get(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/changes/${encodeURIComponent(changeId)}`,
      ifNoneMatch,
    );
  }

  listOpenQuestions(
    specId: string,
    query: ListOpenQuestionsQuery = {},
  ): Promise<ApiResponse<OpenQuestionList>> {
    const params = new URLSearchParams();
    if (query.includeResolved) params.set("includeResolved", "true");
    const qs = params.toString();
    return this.getJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/open-questions${qs ? `?${qs}` : ""}`,
    );
  }

  /** GET one question or assumption → `{ question, spec }`. */
  async readOpenQuestion(
    specId: string,
    questionId: string,
  ): Promise<ApiResponse<OpenQuestionResult>> {
    return this.getJson(openQuestionItemPath(specId, questionId));
  }

  // ────────────────────────────────────────────────────────────────────
  // Open-question writes. The API applies the record and the Markdown
  // marker change in one transaction; these methods only shape the JSON.
  // Keys whose argument is undefined are omitted, explicit nulls are kept
  // (null sectionPath = end of document, null answer = clear the draft),
  // and `version` / `expectedUpdatedAt` are sent exactly as given. Nothing
  // here retries: after a conflict or a timeout the caller must re-read.
  // ────────────────────────────────────────────────────────────────────

  /** POST → 201 `{ question, spec }`. */
  async createOpenQuestion(
    specId: string,
    input: CreateOpenQuestionInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<OpenQuestionResult>> {
    return this.sendJson(
      "POST",
      openQuestionsPath(specId),
      definedOnly({
        version: input.version,
        body: input.body,
        kind: input.kind,
        sectionPath: input.sectionPath,
      }),
      "default",
      options,
    );
  }

  /** PATCH → 200 `{ question, spec }`. */
  async updateOpenQuestion(
    specId: string,
    questionId: string,
    input: UpdateOpenQuestionInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<OpenQuestionResult>> {
    return this.sendJson(
      "PATCH",
      openQuestionItemPath(specId, questionId),
      definedOnly({
        version: input.version,
        expectedUpdatedAt: input.expectedUpdatedAt,
        body: input.body,
        sectionPath: input.sectionPath,
        answer: input.answer,
        status: input.status,
      }),
      "default",
      options,
    );
  }

  /** DELETE with a JSON body → 200 `{ deletedQuestionId, spec }`. */
  async deleteOpenQuestion(
    specId: string,
    questionId: string,
    input: DeleteOpenQuestionInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<DeletedOpenQuestionResult>> {
    return this.sendJson(
      "DELETE",
      openQuestionItemPath(specId, questionId),
      definedOnly({
        version: input.version,
        expectedUpdatedAt: input.expectedUpdatedAt,
      }),
      "default",
      options,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Native Board (`/api/mcp/workspaces/:workspaceId/board…`). Every call
  // names the Workspace explicitly; nothing here reads a Product binding.
  // Errors map in "board" mode: the API's `details.code` is the tool code.
  // Bodies carry only the keys that were given (explicit nulls are kept, so
  // null clears assigneeId / productId on update). Nothing here retries, and
  // idempotency keys and expected versions are forwarded exactly as given.
  // ────────────────────────────────────────────────────────────────────

  /** GET …/board → `Board`. */
  readBoard(workspaceId: string): Promise<ApiResponse<unknown>> {
    return this.getJson(boardPath(workspaceId), "board");
  }

  /** GET …/board/items → `ItemPage`. */
  listBoardItems(
    workspaceId: string,
    query: ListBoardItemsQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const qs = queryString({
      type: query.type,
      state: query.state,
      parentId: query.parentId,
      productId: query.productId,
      assigneeId: query.assigneeId,
      priority: query.priority,
      tag: query.tag,
      q: query.query,
      archived: query.archived,
      limit: query.limit,
      cursor: query.cursor,
    });
    return this.getJson(`${boardPath(workspaceId)}/items${qs}`, "board");
  }

  /** GET …/board/items/:itemId → `ItemDetail`. */
  readBoardItem(
    workspaceId: string,
    itemId: string,
  ): Promise<ApiResponse<unknown>> {
    return this.getJson(boardItemPath(workspaceId, itemId), "board");
  }

  /** GET …/board/items/:itemId/notes → `NotesPage`. */
  listBoardItemNotes(
    workspaceId: string,
    itemId: string,
    query: PageQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const qs = queryString({ limit: query.limit, cursor: query.cursor });
    return this.getJson(
      `${boardItemPath(workspaceId, itemId)}/notes${qs}`,
      "board",
    );
  }

  /** POST …/board/items → 201 `{ item, replayed }`. */
  createBoardItem(
    workspaceId: string,
    input: CreateBoardItemInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `${boardPath(workspaceId)}/items`,
      definedOnly({
        type: input.type,
        parentId: input.parentId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        tags: input.tags,
        assigneeId: input.assigneeId,
        productId: input.productId,
        acceptanceCriteria: input.acceptanceCriteria,
        implementationPrompt: input.implementationPrompt,
        idempotencyKey: input.idempotencyKey,
      }),
      "board",
      options,
    );
  }

  /** PATCH …/board/items/:itemId with only the provided fields → `ItemDetail`. */
  updateBoardItem(
    workspaceId: string,
    itemId: string,
    input: UpdateBoardItemInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      boardItemPath(workspaceId, itemId),
      definedOnly({
        expectedVersion: input.expectedVersion,
        title: input.title,
        description: input.description,
        priority: input.priority,
        tags: input.tags,
        assigneeId: input.assigneeId,
        productId: input.productId,
        acceptanceCriteria: input.acceptanceCriteria,
        implementationPrompt: input.implementationPrompt,
        state: input.state,
        parentId: input.parentId,
      }),
      "board",
      options,
    );
  }

  /** POST …/board/items/:itemId/specifications → `ItemDetail`. */
  linkBoardSpecification(
    workspaceId: string,
    itemId: string,
    input: { specificationId: string; expectedVersion: number },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `${boardItemPath(workspaceId, itemId)}/specifications`,
      {
        expectedVersion: input.expectedVersion,
        specificationId: input.specificationId,
      },
      "board",
      options,
    );
  }

  /** DELETE …/board/items/:itemId/specifications/:specificationId with a JSON body → `ItemDetail`. */
  unlinkBoardSpecification(
    workspaceId: string,
    itemId: string,
    specificationId: string,
    input: { expectedVersion: number },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "DELETE",
      `${boardItemPath(workspaceId, itemId)}/specifications/${boardSegment("specificationId", specificationId)}`,
      { expectedVersion: input.expectedVersion },
      "board",
      options,
    );
  }

  /** POST …/board/items/:itemId/notes → 201 `{ note, replayed }`. */
  appendBoardItemNote(
    workspaceId: string,
    itemId: string,
    input: AppendBoardItemNoteInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `${boardItemPath(workspaceId, itemId)}/notes`,
      { body: input.body, idempotencyKey: input.idempotencyKey },
      "board",
      options,
    );
  }

  /** POST …/board/items/:itemId/archive → `ItemDetail` (Workspace Owner only). */
  archiveBoardItem(
    workspaceId: string,
    itemId: string,
    input: { expectedVersion: number },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `${boardItemPath(workspaceId, itemId)}/archive`,
      { expectedVersion: input.expectedVersion },
      "board",
      options,
    );
  }

  /** POST …/board/items/:itemId/restore → `ItemDetail` (Workspace Owner only). */
  restoreBoardItem(
    workspaceId: string,
    itemId: string,
    input: { expectedVersion: number },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `${boardItemPath(workspaceId, itemId)}/restore`,
      { expectedVersion: input.expectedVersion },
      "board",
      options,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Board import reports (`…/board/imports`). Report reads only: no method
  // here connects a source, runs discovery, changes a mapping, confirms,
  // cancels or retries an import — those stay human-only in the Website.
  // Errors map in "board-import" mode (Board codes, report remediations).
  // ────────────────────────────────────────────────────────────────────

  /** GET …/board/imports → `RunPage` (Workspace Owner only). */
  listBoardImports(
    workspaceId: string,
    query: PageQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const qs = queryString({ limit: query.limit, cursor: query.cursor });
    return this.getJson(
      `${boardPath(workspaceId)}/imports${qs}`,
      "board-import",
    );
  }

  /** GET …/board/imports/:importId → `RunDetail` (Workspace Owner only). */
  readBoardImport(
    workspaceId: string,
    importId: string,
    query: ReadBoardImportQuery = {},
  ): Promise<ApiResponse<unknown>> {
    const qs = queryString({
      limit: query.limit,
      cursor: query.cursor,
      plan: query.plan,
      outcome: query.outcome,
    });
    return this.getJson(
      `${boardPath(workspaceId)}/imports/${boardSegment("importId", importId)}${qs}`,
      "board-import",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Workspace Library (MCP › features/mcp-library-tools.md, PBI 352; the
  // API's `/mcp/…` Library routes of API › features/workspace-library.md §9,
  // proxied by the Website under `/api/mcp/…`). Errors map in "library"
  // mode. These methods only call Kstonebase routes: nothing here ever
  // requests a link the API returns (a temporary link, a one-time
  // `/library/redeem/` link or an approval URL), and nothing is retried.
  // ────────────────────────────────────────────────────────────────────

  /** GET …/workspaces/:workspaceId/library → `McpLibraryListing`. */
  listLibrary(
    workspaceId: string,
    query: ListLibraryQuery = {},
  ): Promise<ApiResponse<McpLibraryListing>> {
    const qs = queryString({ folderId: query.folderId, cursor: query.cursor, limit: query.limit });
    return this.getJson(
      `/api/mcp/workspaces/${librarySegment("workspaceId", workspaceId)}/library${qs}`,
      "library",
    );
  }

  /** GET …/library/files/:fileId → `McpLibraryFile` (with `uploadedBy`). */
  readLibraryFile(fileId: string): Promise<ApiResponse<McpLibraryFile>> {
    return this.getJson(libraryFilePath(fileId), "library");
  }

  /** POST …/library/files/:fileId/link → `{ url, expiresAt }` (common files only). */
  getLibraryFileLink(fileId: string): Promise<ApiResponse<McpLibraryLink>> {
    return this.sendJson("POST", `${libraryFilePath(fileId)}/link`, undefined, "library");
  }

  /** GET …/library/files/:fileId/content → base64 bytes of a common image or audio file ≤ 10 MB. */
  readLibraryFileContent(fileId: string): Promise<ApiResponse<McpLibraryContent>> {
    return this.getJson(`${libraryFilePath(fileId)}/content`, "library");
  }

  /** POST …/library/files/:fileId/access-requests `{purpose}` → 201 `McpLibraryAccessRequest`. */
  requestLibraryFileAccess(
    fileId: string,
    input: { purpose: string },
  ): Promise<ApiResponse<McpLibraryAccessRequest>> {
    return this.sendJson(
      "POST",
      `${libraryFilePath(fileId)}/access-requests`,
      { purpose: input.purpose },
      "library",
    );
  }

  /** GET …/library/access-requests/:requestId → `McpLibraryAccessStatus` (requesting credential only). */
  readLibraryFileAccess(requestId: string): Promise<ApiResponse<McpLibraryAccessStatus>> {
    return this.getJson(
      `/api/mcp/library/access-requests/${librarySegment("requestId", requestId)}`,
      "library",
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Engineering tools (MCP › mcp-engineering-tools.md, PBIs 230 and 239).
  // The shared catalog builds the API `/mcp/…` request; the Website proxies
  // it under `/api/mcp/…`. Reads (the read-only assessment POST included)
  // never carry a policy precondition; writes (MT-I12) carry the agent's
  // expectedPolicyRevision only as the header. Errors map in "engineering"
  // mode, or "engineering-write" for writes (ME6, MT-I13).
  // ────────────────────────────────────────────────────────────────────

  /** One engineering request: a read, or a write with its write options. */
  engineeringRequest(
    method: "GET" | "POST" | "DELETE",
    mcpPath: string,
    body?: Record<string, unknown>,
    options: WriteOptions & { write?: boolean } = {},
  ): Promise<ApiResponse<unknown>> {
    const path = `/api${mcpPath}`;
    const mode: ErrorMappingMode = options.write ? "engineering-write" : "engineering";
    if (method === "GET") return this.getJson(path, mode);
    // Only a write ever sends the policy precondition.
    const writeOptions: WriteOptions =
      options.write && options.policyRevision !== undefined ? { policyRevision: options.policyRevision } : {};
    return this.sendJson(method, path, body, mode, writeOptions);
  }

  /** Convenience for endpoints that never send If-None-Match — narrows the
   *  union so callers don't have to discriminate on `notModified`. The body
   *  type is the documented API shape; it is not validated at runtime. */
  private async getJson<T = unknown>(
    path: string,
    mode: ErrorMappingMode = "default",
  ): Promise<ApiResponse<T>> {
    const res = await this.get(path, undefined, mode);
    if ("notModified" in res) {
      // Should not happen — getJson never asks for conditional requests.
      throw new Error("Unexpected 304 on a non-conditional request.");
    }
    return res as ApiResponse<T>;
  }

  private postJson(
    path: string,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson("POST", path, undefined, "default", options);
  }

  private async sendJson<T = unknown>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    mode: ErrorMappingMode = "default",
    options: WriteOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    // The policy precondition travels only as a header, never in the body.
    if (options.policyRevision !== undefined) {
      headers[POLICY_REVISION_HEADER] = options.policyRevision;
    }

    const res = await this.fetchOnce(
      `${this.apiUrl}${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      mode,
    );

    const text = await this.readBody(res, mode);
    const parsed =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, parsed as ApiErrorBody | null, mode);
    }

    return {
      body: parsed as T,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }

  /**
   * `--check` smoke probe: hits /api/mcp/products and returns the count
   * (or throws on auth failure). Cheaper than a full preflight: the same
   * call the agent does on its first list.
   */
  async checkAuth(): Promise<{ ok: true; products: number }> {
    const res = await this.listProducts();
    const items = (res.body as { items?: unknown[] } | null)?.items;
    return { ok: true, products: Array.isArray(items) ? items.length : 0 };
  }

  /**
   * Phase 4: probe whether a given id resolves to a Workspace, a Product,
   * or neither. Used at server startup to detect the legacy binding shape
   * (`{"workspaceId": "<old id>"}` where `<old id>` is now a Product id).
   * Errors other than 404 propagate so the caller can decide whether to
   * keep going.
   */
  async resolveIdShape(
    id: string,
  ): Promise<"workspace" | "product" | "unknown"> {
    try {
      await this.readWorkspace(id);
      return "workspace";
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    try {
      await this.readProduct(id);
      return "product";
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    return "unknown";
  }

  // ────────────────────────────────────────────────────────────────────
  // Write endpoints
  // ────────────────────────────────────────────────────────────────────

  startNewVersion(
    specId: string,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/start-new-version`,
      options,
    );
  }

  updateSpecificationContent(
    specId: string,
    body: { content: string; version: number; changeNote?: string },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/content`,
      body,
      "default",
      options,
    );
  }

  updateSpecificationSection(
    specId: string,
    body: {
      sectionPath: string;
      newSection: string;
      version: number;
      changeNote?: string;
    },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/section`,
      body,
      "default",
      options,
    );
  }

  requestReview(
    specId: string,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/request-review`,
      options,
    );
  }

  discardDraft(
    specId: string,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/discard-draft`,
      options,
    );
  }

  createFreeSpecification(
    productId: string,
    body: {
      title: string;
      path?: string;
      tags?: string[];
      content?: string;
    },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications`,
      body,
      "default",
      options,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer endpoints (per Kstonebase MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  createProduct(
    workspaceId: string,
    body: {
      name: string;
      description?: string;
      tags?: string[];
      /** Deprecated (PBI 271): sent only when an older agent passes it; the API refuses anything but "free". */
      specificationManagementType?: string;
    },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/products`,
      body,
      "default",
      options,
    );
  }

  findProductBySubject(
    workspaceId: string,
    query: { subject: string; limit?: number },
  ): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ subject: query.subject });
    if (typeof query.limit === "number") {
      params.set("limit", String(query.limit));
    }
    return this.getJson(
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/products/search?${params.toString()}`,
    );
  }

  // `version` is accepted for backward compatibility only. append_context no
  // longer edits the document, so there is nothing to contend for and the API
  // ignores it.
  appendContext(
    specId: string,
    body: {
      content: string;
      sectionTitle?: string;
      version?: number;
    },
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/append-context`,
      body,
      "default",
      options,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Effective Workspace instructions (`GET /api/mcp/agent-policy`, the
  // Website proxy of the API resolver; API frozen contract PBI 174).
  // ────────────────────────────────────────────────────────────────────

  /**
   * Resolve the effective policy of 1–25 targets. A server without the
   * resolver — a 404 without a JSON `error.code` envelope, or a body that is
   * not JSON — throws POLICY_UNSUPPORTED; any other failure maps as usual.
   * The body is returned as sent; callers validate it.
   */
  async getAgentPolicy(
    targets: PolicyTarget[],
    query: AgentPolicyQuery = {},
  ): Promise<ApiResponse<AgentPolicyResponse>> {
    const params = new URLSearchParams();
    for (const target of targets) {
      params.append("target", `${target.type}:${target.id}`);
    }
    if (query.omitInstructions) params.set("instructions", "omit");
    const res = await this.fetcher(
      `${this.apiUrl}/api/mcp/agent-policy?${params.toString()}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
      },
    );
    const text = await res.text();
    let body: unknown = null;
    let json = true;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        json = false;
      }
    }
    if (!res.ok) {
      const code = json ? (body as ApiErrorBody | null)?.error?.code : undefined;
      if (res.status === 404 && typeof code !== "string") throw policyUnsupported();
      throw mapApiError(
        res.status,
        json ? (body as ApiErrorBody | null) : { error: { message: "API returned a non-JSON payload." } },
      );
    }
    if (!json) throw policyUnsupported();
    return {
      body: body as AgentPolicyResponse,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Specification authoring (`/api/mcp/authoring-context`,
  // `/api/mcp/authoring-plans/…`, the Website proxies of the API's
  // `/mcp/…` routes; T1–T3, T6). Errors map in "authoring" mode: a route
  // answering 404/405/501 without the API error envelope (an older API or
  // Website) is AUTHORING_UNSUPPORTED. Nothing here retries; prepare and
  // validate are reads and never send a policy precondition.
  // ────────────────────────────────────────────────────────────────────

  /** GET …/authoring-context?target=<type>:<id> → the authoring context (schemaVersion 1). */
  readAuthoringContext(target: PolicyTarget): Promise<ApiResponse<unknown>> {
    const params = new URLSearchParams({ target: `${target.type}:${target.id}` });
    return this.getJson(`/api/mcp/authoring-context?${params.toString()}`, "authoring");
  }

  /** POST …/authoring-plans/prepare → 200 `{ valid, plan, findings }`. */
  prepareAuthoringPlan(input: AuthoringPlanInput): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      "/api/mcp/authoring-plans/prepare",
      authoringPlanBody(input),
      "authoring",
    );
  }

  /** POST …/authoring-plans/validate → 200 `{ valid, plan, findings }`. */
  validateAuthoringPlan(input: ValidateAuthoringPlanInput): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      "/api/mcp/authoring-plans/validate",
      { ...authoringPlanBody(input), ...definedOnly({ planDigest: input.planDigest }) },
      "authoring",
    );
  }

  /** POST …/authoring-plans/apply → 201 (first success) or 200 (`replayed: true`). */
  applyAuthoringPlan(
    input: ApplyAuthoringPlanInput,
    options: WriteOptions = {},
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      "/api/mcp/authoring-plans/apply",
      {
        ...authoringPlanBody(input),
        planDigest: input.planDigest,
        idempotencyKey: input.idempotencyKey,
      },
      "authoring",
      options,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private async get(
    path: string,
    ifNoneMatch?: string,
    mode: ErrorMappingMode = "default",
  ): Promise<ApiResponse<unknown> | NotModified> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;

    const res = await this.fetchOnce(
      `${this.apiUrl}${path}`,
      { method: "GET", headers },
      mode,
    );

    if (res.status === 304) {
      return {
        notModified: true,
        etag: res.headers.get("etag") ?? "",
        status: 304,
      };
    }

    const text = await this.readBody(res, mode);
    const body =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, body as ApiErrorBody | null, mode);
    }

    return {
      body,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }

  /**
   * The response body. For an engineering request, a body that fails to
   * arrive after the headers is INTERNAL_ERROR with the engineering
   * remediation (a write's says it may or may not have been applied).
   */
  private async readBody(res: Response, mode: ErrorMappingMode): Promise<string> {
    if (mode !== "engineering" && mode !== "engineering-write") return res.text();
    try {
      return await res.text();
    } catch (err) {
      throw new McpToolError(
        "INTERNAL_ERROR",
        `The response did not complete: ${(err as Error)?.message ?? String(err)}`,
        boardRemediation("INTERNAL_ERROR", mode),
      );
    }
  }

  /**
   * One HTTP attempt, never retried. A request that fails in flight on a
   * Board call becomes INTERNAL_ERROR with the Board remediation (re-read
   * first; retry a create or note only with the same idempotencyKey; import
   * report reads: retry the read once). Other tools, the authoring ones
   * included, keep their existing behaviour (the error propagates as is).
   */
  private async fetchOnce(
    url: string,
    init: RequestInit,
    mode: ErrorMappingMode,
  ): Promise<Response> {
    if (mode === "default" || mode === "authoring" || mode === "library") return this.fetcher(url, init);
    try {
      return await this.fetcher(url, init);
    } catch (err) {
      throw new McpToolError(
        "INTERNAL_ERROR",
        `The request did not complete: ${(err as Error)?.message ?? String(err)}`,
        boardRemediation("INTERNAL_ERROR", mode),
      );
    }
  }
}

function policyUnsupported(): McpToolError {
  return toolError(
    "POLICY_UNSUPPORTED",
    "This Kstonebase server does not provide Workspace instructions.",
  );
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: "API returned a non-JSON payload." } };
  }
}

function openQuestionsPath(specId: string): string {
  return `/api/mcp/specifications/${pathSegment("specId", specId)}/open-questions`;
}

function openQuestionItemPath(specId: string, questionId: string): string {
  return `${openQuestionsPath(specId)}/${pathSegment("questionId", questionId)}`;
}

/**
 * Percent-encode one id for use as a path segment. Empty, "." and ".." ids
 * are rejected before any request: URL parsing would collapse them into a
 * different path, which must never happen on a PATCH or DELETE.
 */
function pathSegment(name: string, id: string): string {
  if (id === "" || id === "." || id === "..") {
    throw new McpToolError(
      "VALIDATION_ERROR",
      `${name} must be a non-empty id other than "." or "..".`,
      "Pass the id exactly as returned by list_specifications, list_open_questions or read_open_question.",
    );
  }
  return encodeURIComponent(id);
}

function libraryFilePath(fileId: string): string {
  return `/api/mcp/library/files/${librarySegment("fileId", fileId)}`;
}

/** pathSegment with a Library remediation. */
function librarySegment(name: string, id: string): string {
  if (id === "" || id === "." || id === "..") {
    throw new McpToolError(
      "VALIDATION_ERROR",
      `${name} must be a non-empty id other than "." or "..".`,
      "Pass the id exactly as returned by list_workspaces, list_library or request_library_file_access.",
    );
  }
  return encodeURIComponent(id);
}

function boardPath(workspaceId: string): string {
  return `/api/mcp/workspaces/${boardSegment("workspaceId", workspaceId)}/board`;
}

function boardItemPath(workspaceId: string, itemId: string): string {
  return `${boardPath(workspaceId)}/items/${boardSegment("itemId", itemId)}`;
}

/** pathSegment with a Board remediation. */
function boardSegment(name: string, id: string): string {
  if (id === "" || id === "." || id === "..") {
    throw new McpToolError(
      "VALIDATION_ERROR",
      `${name} must be a non-empty id other than "." or "..".`,
      "Pass the id exactly as returned by list_workspaces, list_board_items, read_board_item, list_board_imports or the specification tools.",
    );
  }
  return encodeURIComponent(id);
}

/**
 * Build a query string ("" or "?…") from the defined values only. Numbers
 * and booleans are sent as their string form (`archived=false` stays
 * explicit when the agent passed false).
 */
function queryString(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

/**
 * The shared part of a plan request, in contract order, with exactly the
 * contract fields: absent optional fields are omitted, never null, and each
 * operation carries only the fields of its action.
 */
function authoringPlanBody(input: AuthoringPlanInput): Record<string, unknown> {
  return definedOnly({
    container: { type: input.container.type, id: input.container.id },
    authoringRevision: input.authoringRevision,
    subjects: input.subjects.map((s) => ({ key: s.key, title: s.title, folder: s.folder })),
    operations: input.operations.map(authoringOperationBody),
    indexContent: input.indexContent?.map((e) => ({ path: e.path, content: e.content })),
  });
}

function authoringOperationBody(op: AuthoringOperation): Record<string, unknown> {
  switch (op.action) {
    case "create":
      return definedOnly({
        action: op.action,
        subject: op.subject,
        path: op.path,
        title: op.title,
        content: op.content,
        tags: op.tags,
      });
    case "update":
      return definedOnly({
        action: op.action,
        subject: op.subject,
        specificationId: op.specificationId,
        expectedVersion: op.expectedVersion,
        content: op.content,
        changeNote: op.changeNote,
      });
    case "reuse":
      return {
        action: op.action,
        subject: op.subject,
        specificationId: op.specificationId,
        expectedVersion: op.expectedVersion,
      };
  }
}

/** Copy only the keys whose value is not undefined; nulls are kept. */
function definedOnly(entries: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  return err instanceof McpToolError && err.code === "NOT_FOUND";
}
