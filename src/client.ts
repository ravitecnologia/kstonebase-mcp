// Kstonebase HTTP API client. Wraps the /api/mcp/* surface so tool
// handlers stay focused on argument shaping. Every outbound request carries
// `Authorization: Bearer kstonebase_pat_…`; no other auth artifacts are sent
// (per Kstonebase spec "mcp-server" §5 "Auth header").

import { McpToolError, mapApiError, type ApiErrorBody } from "./errors.js";

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
    );
  }

  /** PATCH → 200 `{ question, spec }`. */
  async updateOpenQuestion(
    specId: string,
    questionId: string,
    input: UpdateOpenQuestionInput,
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
    );
  }

  /** DELETE with a JSON body → 200 `{ deletedQuestionId, spec }`. */
  async deleteOpenQuestion(
    specId: string,
    questionId: string,
    input: DeleteOpenQuestionInput,
  ): Promise<ApiResponse<DeletedOpenQuestionResult>> {
    return this.sendJson(
      "DELETE",
      openQuestionItemPath(specId, questionId),
      definedOnly({
        version: input.version,
        expectedUpdatedAt: input.expectedUpdatedAt,
      }),
    );
  }

  /** Convenience for endpoints that never send If-None-Match — narrows the
   *  union so callers don't have to discriminate on `notModified`. The body
   *  type is the documented API shape; it is not validated at runtime. */
  private async getJson<T = unknown>(path: string): Promise<ApiResponse<T>> {
    const res = await this.get(path);
    if ("notModified" in res) {
      // Should not happen — getJson never asks for conditional requests.
      throw new Error("Unexpected 304 on a non-conditional request.");
    }
    return res as ApiResponse<T>;
  }

  private postJson(path: string): Promise<ApiResponse<unknown>> {
    return this.sendJson("POST", path, undefined);
  }

  private async sendJson<T = unknown>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const res = await this.fetcher(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    const parsed =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, parsed as ApiErrorBody | null);
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

  startNewVersion(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/start-new-version`,
    );
  }

  updateSpecificationContent(
    specId: string,
    body: { content: string; version: number; changeNote?: string },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/content`,
      body,
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
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "PATCH",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/section`,
      body,
    );
  }

  requestReview(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/request-review`,
    );
  }

  discardDraft(specId: string): Promise<ApiResponse<unknown>> {
    return this.postJson(
      `/api/mcp/specifications/${encodeURIComponent(specId)}/discard-draft`,
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
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/products/${encodeURIComponent(productId)}/specifications`,
      body,
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
      specificationManagementType?: "free" | "web_application";
    },
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/workspaces/${encodeURIComponent(workspaceId)}/products`,
      body,
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
  ): Promise<ApiResponse<unknown>> {
    return this.sendJson(
      "POST",
      `/api/mcp/specifications/${encodeURIComponent(specId)}/append-context`,
      body,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Internals
  // ────────────────────────────────────────────────────────────────────

  private async get(
    path: string,
    ifNoneMatch?: string,
  ): Promise<ApiResponse<unknown> | NotModified> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
    };
    if (ifNoneMatch) headers["if-none-match"] = ifNoneMatch;

    const res = await this.fetcher(`${this.apiUrl}${path}`, {
      method: "GET",
      headers,
    });

    if (res.status === 304) {
      return {
        notModified: true,
        etag: res.headers.get("etag") ?? "",
        status: 304,
      };
    }

    const text = await res.text();
    const body =
      text.length > 0
        ? (safeParseJson(text) as ApiErrorBody | unknown)
        : null;

    if (!res.ok) {
      throw mapApiError(res.status, body as ApiErrorBody | null);
    }

    return {
      body,
      etag: res.headers.get("etag"),
      status: res.status,
    };
  }
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
