// Tool-level contract tests for the open-question tools (Kstonebase MCP spec
// "mcp-open-question-management" and its implementation contract). The MCP
// server is built exactly as both transports build it (buildServer) and driven
// by the SDK client over an in-memory transport. The API behind it is a small
// stateful fake of the pinned HTTP contract, so these tests prove what the
// package owns: discovery, argument forwarding, token threading, result
// passthrough and error mapping. Record/Markdown behaviour is the API's.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_OQ_TOOL_TEST";
const API_URL = "https://api.kstonebase.test";

// ──────────────────────────────────────────────────────────────────────────
// Fake Kstonebase API (open-question contract §1–§5, adapter-relevant subset)
// ──────────────────────────────────────────────────────────────────────────

type SpecStatus = "DRAFT" | "NEEDS_REVIEW" | "REVIEWED" | "GENERATING";

interface FakeSpecInit {
  id: string;
  /** "product:<id>" or "workspace:<id>" — used for token allowlists. */
  owner: string;
  version: number;
  status?: SpecStatus;
  archived?: boolean;
  headings: string[];
}

interface FakeRow {
  id: string;
  specificationId: string;
  kind: "QUESTION" | "ASSUMPTION";
  body: string;
  answer: string | null;
  status: "OPEN" | "RESOLVED" | "DISMISSED";
  anchor: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Test-only bookkeeping, never serialised.
  markerPresent: boolean;
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface FakeReply {
  status: number;
  json: unknown;
}

const LOCKED_HINTS: Record<string, string> = {
  REVIEWED:
    "Answering an open question (update_open_question with its answer and status RESOLVED) or accepting or rejecting an open assumption (status RESOLVED or DISMISSED), with nothing else, works here and starts a new draft by itself. For any other change, call start_new_version first.",
  NEEDS_REVIEW:
    "The specification is waiting for review. Answering an open question (update_open_question with its answer and status RESOLVED) or accepting or rejecting an open assumption (status RESOLVED or DISMISSED), with nothing else, works here and moves it back to Draft. For any other change a human must move it Back to draft in Kstonebase; start_new_version does not unlock Needs Review.",
  GENERATING: "Wait for generation to finish.",
};

function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FakeReply {
  return {
    status,
    json: { error: { code, message, ...(details ? { details } : {}) } },
  };
}

/** Go's RFC 3339 millisecond rendering: trailing zeros dropped. */
function goTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.?0+Z$/, "Z");
}

class FakeKstonebaseApi {
  readonly requests: RecordedRequest[] = [];
  private readonly specs = new Map<
    string,
    FakeSpecInit & { status: SpecStatus; approvedVersion: number }
  >();
  private rows: FakeRow[] = [];
  private clock = Date.parse("2026-09-26T18:04:05.100Z");
  private seq = 0;

  constructor(
    specs: FakeSpecInit[],
    private readonly options: { allowlist?: string[]; writeScope?: boolean } = {},
  ) {
    for (const s of specs) {
      this.specs.set(s.id, { ...s, status: s.status ?? "DRAFT", approvedVersion: 2 });
    }
  }

  /** Simulate a lifecycle change made elsewhere (review request, approval). */
  setStatus(specId: string, status: SpecStatus): void {
    const s = this.specs.get(specId);
    if (s) s.status = status;
  }

  /** Simulate a marker edited away outside the tools. */
  removeMarker(questionId: string): void {
    const row = this.rows.find((r) => r.id === questionId);
    if (row) row.markerPresent = false;
  }

  private tick(): string {
    this.clock += 10;
    return goTime(this.clock);
  }

  private meta(specId: string) {
    const s = this.specs.get(specId)!;
    return {
      id: s.id,
      version: s.version,
      approvedVersion: s.approvedVersion,
      status: s.status,
      openQuestionsCount: this.rows.filter(
        (r) => r.specificationId === specId && r.status === "OPEN",
      ).length,
    };
  }

  private dto(row: FakeRow) {
    const { markerPresent: _hidden, ...rest } = row;
    return { ...rest };
  }

  /** Resolve sectionPath → anchor (line number of the heading, as a string). */
  private anchorFor(
    specId: string,
    sectionPath: string | null | undefined,
  ): { anchor: string | null } | FakeReply {
    const spec = this.specs.get(specId)!;
    if (sectionPath === undefined || sectionPath === null) {
      if (spec.headings.length === 0) return { anchor: null };
      return { anchor: String(2 * (spec.headings.length - 1) + 1) };
    }
    const wanted = sectionPath.replace(/^#+\s*/, "").trim().toLowerCase();
    const matches = spec.headings
      .map((h, i) => ({ text: h.replace(/^#+\s*/, "").trim().toLowerCase(), line: 2 * i + 1 }))
      .filter((h) => h.text === wanted);
    if (matches.length === 0) {
      return apiError(404, "NOT_FOUND", `No section matches "${sectionPath}".`, {
        code: "SECTION_NOT_FOUND",
        sectionPath,
      });
    }
    if (matches.length > 1) {
      return apiError(409, "CONFLICT", `More than one section matches "${sectionPath}".`, {
        code: "SECTION_AMBIGUOUS",
        sectionPath,
        hint: "Pass a heading that matches exactly one section.",
      });
    }
    return { anchor: String(matches[0].line) };
  }

  handle(
    method: string,
    url: URL,
    headers: Record<string, string>,
    rawBody: string | undefined,
  ): FakeReply {
    const body = rawBody === undefined ? undefined : (JSON.parse(rawBody) as unknown);
    this.requests.push({ method, path: url.pathname + url.search, headers, body });

    if (headers.authorization !== `Bearer ${TOKEN}`) {
      return apiError(401, "UNAUTHORIZED", "AUTH_REQUIRED", { code: "AUTH_REQUIRED" });
    }
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    // ["api","mcp","specifications",specId,("open-questions",(questionId))]
    if (segments[0] !== "api" || segments[1] !== "mcp" || segments[2] !== "specifications") {
      return apiError(404, "NOT_FOUND", "Not found.");
    }
    const specId = segments[3];
    const spec = this.specs.get(specId);
    if (!spec) return apiError(404, "NOT_FOUND", "Specification not found.");
    if (this.options.allowlist && !this.options.allowlist.includes(spec.owner)) {
      return apiError(403, "FORBIDDEN", "TOKEN_SCOPE_MISMATCH", { code: "TOKEN_SCOPE_MISMATCH" });
    }

    if (segments.length === 4 && method === "GET") {
      return {
        status: 200,
        json: {
          id: spec.id,
          content: spec.headings.join("\n\n"),
          status: spec.status,
          version: spec.version,
          approvedVersion: spec.approvedVersion,
          openQuestionsCount: this.meta(specId).openQuestionsCount,
        },
      };
    }
    if (segments[4] !== "open-questions" || segments.length > 6) {
      return apiError(404, "NOT_FOUND", "Not found.");
    }

    const questionId = segments[5];
    if (method === "GET" && questionId === undefined) {
      const includeResolved = url.searchParams.get("includeResolved") === "true";
      const items = this.rows
        .filter((r) => r.specificationId === specId)
        .filter((r) => includeResolved || r.status === "OPEN")
        .map((r) => this.dto(r));
      return { status: 200, json: { items, spec: this.meta(specId) } };
    }

    const row =
      questionId === undefined
        ? undefined
        : this.rows.find((r) => r.id === questionId && r.specificationId === specId);

    if (method === "GET") {
      if (!row) return apiError(404, "NOT_FOUND", "Question not found.");
      return { status: 200, json: { question: this.dto(row), spec: this.meta(specId) } };
    }

    // ── mutations ──
    if (this.options.writeScope === false) {
      return apiError(403, "FORBIDDEN", "TOKEN_SCOPE_INSUFFICIENT", {
        code: "TOKEN_SCOPE_INSUFFICIENT",
      });
    }
    const payload = (body ?? {}) as Record<string, unknown>;
    const allowed =
      method === "POST"
        ? ["version", "body", "kind", "sectionPath"]
        : method === "PATCH"
          ? ["version", "expectedUpdatedAt", "body", "sectionPath", "answer", "status"]
          : ["version", "expectedUpdatedAt"];
    const unknown = Object.keys(payload).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        fields: unknown.map((k) => `unknown field "${k}"`),
      });
    }
    if (!Number.isInteger(payload.version)) {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", { fields: ["version is required"] });
    }
    if (method !== "POST" && typeof payload.expectedUpdatedAt !== "string") {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        fields: ["expectedUpdatedAt is required"],
      });
    }
    if (spec.archived) {
      return apiError(403, "SPEC_ARCHIVED", "Specification is archived.", {
        code: "SPEC_ARCHIVED",
        hint: "restore the spec first",
      });
    }
    // Like the API (contract §11 and its decision of 2026-09-26 on
    // assumptions): settling an OPEN item — answering a question (RESOLVED),
    // accepting or rejecting an assumption (RESOLVED or DISMISSED), without
    // body or sectionPath — is also accepted on a Needs Review or Reviewed
    // spec and moves it to Draft; nothing else is.
    const locked = () =>
      apiError(403, "SPEC_LOCKED", "Specification is not editable in its current status.", {
        code: "SPEC_LOCKED",
        status: spec.status,
        hint: LOCKED_HINTS[spec.status],
      });
    const settling =
      method === "PATCH" &&
      (payload.status === "RESOLVED" || payload.status === "DISMISSED") &&
      !Object.hasOwn(payload, "body") &&
      !Object.hasOwn(payload, "sectionPath");
    const reopens = settling && (spec.status === "NEEDS_REVIEW" || spec.status === "REVIEWED");
    if (spec.status !== "DRAFT" && !reopens) return locked();
    if (method !== "POST" && !row) return apiError(404, "NOT_FOUND", "Question not found.");
    if (payload.version !== spec.version) {
      return apiError(409, "CONFLICT", "Specification was modified by someone else.", {
        code: "STALE_VERSION",
        hint: "Re-read the specification and retry with its current version.",
      });
    }
    if (row && payload.expectedUpdatedAt !== row.updatedAt) {
      return apiError(409, "CONFLICT", "The question changed since you read it.", {
        code: "STALE_QUESTION",
        hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
      });
    }

    if (method === "POST") return this.create(spec.id, payload);
    const settles =
      row?.status === "OPEN" && (row.kind === "ASSUMPTION" || payload.status === "RESOLVED");
    if (reopens && !settles) return locked();
    if (method === "PATCH" && reopens) {
      const before = spec.status;
      spec.status = "DRAFT";
      const reply = this.update(spec.id, row!, payload);
      if (reply.status !== 200) spec.status = before;
      return reply;
    }
    if (method === "PATCH") return this.update(spec.id, row!, payload);
    if (method === "DELETE") {
      this.rows = this.rows.filter((r) => r !== row);
      spec.version += 1;
      return { status: 200, json: { deletedQuestionId: row!.id, spec: this.meta(specId) } };
    }
    return apiError(404, "NOT_FOUND", "Not found.");
  }

  private create(specId: string, payload: Record<string, unknown>): FakeReply {
    const kind = (payload.kind ?? "QUESTION") as FakeRow["kind"];
    const text = typeof payload.body === "string" ? payload.body.trim() : "";
    if (text === "") {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", { fields: ["body must not be blank"] });
    }
    if (kind === "ASSUMPTION" && /[_\n]/.test(text)) {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        fields: ["assumption body cannot contain _ or line breaks"],
      });
    }
    const placed = this.anchorFor(specId, payload.sectionPath as string | null | undefined);
    if ("status" in placed) return placed;
    const duplicate = this.rows.some(
      (r) =>
        r.specificationId === specId &&
        r.kind === kind &&
        r.body === text &&
        r.anchor === placed.anchor &&
        (r.status === "OPEN" || (r.kind === "QUESTION" && r.status === "DISMISSED")),
    );
    if (duplicate) {
      return apiError(409, "CONFLICT", "An identical item already exists in that section.", {
        code: "MARKER_AMBIGUOUS",
        reason: "DUPLICATE_IN_SECTION",
        hint: "Reword the item or place it in another section.",
      });
    }
    const now = this.tick();
    const row: FakeRow = {
      id: `q_${++this.seq}`,
      specificationId: specId,
      kind,
      body: text,
      answer: null,
      status: "OPEN",
      anchor: placed.anchor,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
      markerPresent: true,
    };
    this.rows.push(row);
    this.specs.get(specId)!.version += 1;
    return { status: 201, json: { question: this.dto(row), spec: this.meta(specId) } };
  }

  private update(specId: string, row: FakeRow, payload: Record<string, unknown>): FakeReply {
    const has = (k: string) => Object.hasOwn(payload, k);
    const changes = ["body", "sectionPath", "answer", "status"].filter(has);
    if (changes.length === 0) {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        fields: ["at least one of body, sectionPath, answer or status is required"],
      });
    }
    const to = (payload.status ?? row.status) as FakeRow["status"];
    const invalid = (hint: string) =>
      apiError(400, "BAD_REQUEST", "Invalid transition.", {
        code: "INVALID_TRANSITION",
        from: row.status,
        to,
        hint,
      });

    if (row.status !== "OPEN") {
      const statusOnly = changes.length === 1 && has("status");
      if (statusOnly && to === row.status) {
        return { status: 200, json: { question: this.dto(row), spec: this.meta(specId) } };
      }
      if (!(statusOnly && to === "OPEN")) {
        return invalid("Reopen the item with status OPEN alone before changing it.");
      }
      Object.assign(row, {
        status: "OPEN",
        answer: null,
        resolvedAt: null,
        markerPresent: true,
        updatedAt: this.tick(),
      });
      this.specs.get(specId)!.version += 1;
      return { status: 200, json: { question: this.dto(row), spec: this.meta(specId) } };
    }

    if (to !== "OPEN" && (has("body") || has("sectionPath"))) {
      return invalid("Change body or sectionPath and the status in separate calls.");
    }
    if (has("answer") && payload.answer !== null && row.kind === "ASSUMPTION") {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        fields: ["answer applies to questions only"],
      });
    }
    const next: FakeRow = { ...row };
    if (has("body")) next.body = String(payload.body).trim();
    if (has("sectionPath")) {
      const placed = this.anchorFor(specId, payload.sectionPath as string | null);
      if ("status" in placed) return placed;
      next.anchor = placed.anchor;
    }
    if (has("answer")) {
      next.answer = payload.answer === null ? null : String(payload.answer).trim();
    }
    if (to === "RESOLVED" && row.kind === "QUESTION" && !next.answer) {
      return apiError(422, "VALIDATION_ERROR", "Invalid input", {
        code: "ANSWER_REQUIRED",
        fields: ["answer is required to resolve a question"],
      });
    }
    const touchesMarker =
      has("body") || has("sectionPath") || to === "RESOLVED" ||
      (to === "DISMISSED" && row.kind === "ASSUMPTION");
    if (touchesMarker && !row.markerPresent) {
      return apiError(409, "CONFLICT", "The question's marker is not in the document.", {
        code: "MARKER_NOT_FOUND",
        hint: "The marker was edited or removed outside this tool. Re-read the specification; restore the marker text or delete the question.",
      });
    }
    next.status = to;
    if (to === "RESOLVED") next.resolvedAt = this.tickPreview();
    if (to === "RESOLVED" || (to === "DISMISSED" && row.kind === "ASSUMPTION")) {
      next.markerPresent = false;
    }
    const unchanged =
      next.body === row.body &&
      next.anchor === row.anchor &&
      next.answer === row.answer &&
      next.status === row.status;
    if (unchanged) {
      return { status: 200, json: { question: this.dto(row), spec: this.meta(specId) } };
    }
    next.updatedAt = this.tick();
    Object.assign(row, next);
    this.specs.get(specId)!.version += 1;
    return { status: 200, json: { question: this.dto(row), spec: this.meta(specId) } };
  }

  private tickPreview(): string {
    return goTime(this.clock + 10);
  }
}

function fetcherFor(api: FakeKstonebaseApi): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const reply = api.handle(
      init?.method ?? "GET",
      url,
      headers,
      typeof init?.body === "string" ? init.body : undefined,
    );
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

// ──────────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiUrl: API_URL,
    apiUrlSource: "argument",
    token: TOKEN,
    workspaceId: null,
    workspaceSource: "none",
    productId: null,
    productSource: "none",
    bindingMode: "discovery",
    telemetryEnabled: false,
    allowInsecure: false,
    ...overrides,
  };
}

interface Connected {
  mcp: Client;
  close: () => Promise<void>;
}

async function connectTo(fetcher: typeof fetch, config = makeConfig()): Promise<Connected> {
  const client = new KstonebaseClient({ apiUrl: config.apiUrl, token: TOKEN, fetcher });
  const server = buildServer({ config, client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "open-question-tools-test", version: "0.0.0" });
  await mcp.connect(clientSide);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

interface ToolOutcome {
  isError: boolean;
  data: Record<string, any>;
  text: string;
}

async function callTool(mcp: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const res = await mcp.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return {
    isError: res.isError === true,
    data: (res.structuredContent ?? {}) as Record<string, any>,
    text: content[0]?.text ?? "",
  };
}

async function ok(mcp: Client, name: string, args: Record<string, unknown>) {
  const out = await callTool(mcp, name, args);
  if (out.isError) throw new Error(`${name} failed: ${out.text}`);
  // The text block is the same JSON the structured content carries.
  expect(JSON.parse(out.text)).toEqual(out.data);
  return out.data;
}

async function failure(mcp: Client, name: string, args: Record<string, unknown>) {
  const out = await callTool(mcp, name, args);
  expect(out.isError).toBe(true);
  return out;
}

let stderrLines: string[] = [];

beforeEach(() => {
  stderrLines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PRODUCT_SPEC: FakeSpecInit = {
  id: "s_prod",
  owner: "product:p_1",
  version: 41,
  headings: ["# Refund policy", "## Refunds", "## Scope"],
};

const WORKSPACE_SPEC: FakeSpecInit = {
  id: "s_ws",
  owner: "workspace:w_1",
  version: 2147483600,
  headings: ["# Platform ADR", "## Decision", "## Consequences"],
};

// ──────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────

// The contract's exact wording (implementation contract §6), kept as
// independent literals so a drift in tools.ts fails here.
const CONTRACT_DESCRIPTIONS: Record<string, string> = {
  read_open_question:
    "Read one open question or assumption on a Specification, together with the Specification's current version. Read-only. Returns the item's updatedAt, which update_open_question and delete_open_question need as expectedUpdatedAt.",
  create_open_question:
    'Add an open question (kind QUESTION, the default) or an assumption (kind ASSUMPTION) to a Draft Specification. The record and its inline marker are written together: <open_question>BODY</open_question> or _Assumption: BODY_ at the end of the section named by sectionPath (a heading such as "## Scope"), or at the end of the document when sectionPath is omitted. Requires the Specification\'s current version and advances it.',
  update_open_question:
    "Edit, move, resolve, dismiss or reopen an open question or assumption on a Draft Specification. The record and the Markdown change together: resolving a question replaces its marker with the answer (an answer is required); dismissing a question keeps its marker; resolving an assumption turns it into plain prose; dismissing an assumption strikes it through as not valid; reopening restores an unresolved marker and keeps earlier decision prose. Answering a question and accepting or rejecting an assumption also work on a Specification in Needs Review or Reviewed: resolving an OPEN question with its answer, or resolving or dismissing an OPEN assumption (no body or sectionPath), moves the Specification to Draft in the same change, at the same version from Needs Review or as a new draft from Reviewed, so do not call start_new_version first. Body, sectionPath and answer change only while the item is OPEN. Requires version and expectedUpdatedAt from your latest read; after STALE_VERSION or STALE_QUESTION, re-read before retrying.",
  delete_open_question:
    "Permanently delete an open question or assumption from a Draft Specification. Removes the record and any marker still in the document; prose written by an earlier resolution or dismissal stays. This cannot be undone: to set an item aside, use update_open_question with status DISMISSED instead. Requires version and expectedUpdatedAt from your latest read.",
};

const CONTRACT_ANNOTATIONS: Record<string, Record<string, boolean>> = {
  read_open_question: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  create_open_question: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  update_open_question: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  delete_open_question: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

// The contract's zod shapes, registered on a reference server so the
// comparison is against the SDK's own JSON Schema rendering of them.
async function contractSchemas(): Promise<Record<string, unknown>> {
  const reference = new McpServer({ name: "contract", version: "0" }, { capabilities: { tools: {} } });
  const shapes: Record<string, z.ZodRawShape> = {
    read_open_question: { specId: z.string(), questionId: z.string() },
    create_open_question: {
      specId: z.string(),
      version: z.number().int(),
      body: z.string(),
      kind: z.enum(["QUESTION", "ASSUMPTION"]).optional(),
      sectionPath: z.string().nullable().optional(),
    },
    update_open_question: {
      specId: z.string(),
      questionId: z.string(),
      version: z.number().int(),
      expectedUpdatedAt: z.string(),
      body: z.string().optional(),
      sectionPath: z.string().nullable().optional(),
      answer: z.string().nullable().optional(),
      status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
    },
    delete_open_question: {
      specId: z.string(),
      questionId: z.string(),
      version: z.number().int(),
      expectedUpdatedAt: z.string(),
    },
  };
  for (const [name, inputSchema] of Object.entries(shapes)) {
    reference.registerTool(name, { inputSchema }, async () => ({ content: [] }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await reference.connect(a);
  const client = new Client({ name: "reference", version: "0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
}

describe("open-question tools — discovery", () => {
  it("advertises the four tools with the contract's schemas, descriptions and annotations", async () => {
    const { mcp, close } = await connectTo(fetcherFor(new FakeKstonebaseApi([PRODUCT_SPEC])));
    const { tools } = await mcp.listTools();
    const reference = await contractSchemas();
    for (const name of Object.keys(CONTRACT_DESCRIPTIONS)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.description).toBe(CONTRACT_DESCRIPTIONS[name]);
      expect(tool!.annotations).toEqual(CONTRACT_ANNOTATIONS[name]);
      expect(tool!.inputSchema).toEqual(reference[name]);
    }
    await close();
  });

  it("renders the optional/nullable semantics the agent sees", async () => {
    const { mcp, close } = await connectTo(fetcherFor(new FakeKstonebaseApi([PRODUCT_SPEC])));
    const { tools } = await mcp.listTools();
    const schema = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema as {
        properties: Record<string, any>;
        required?: string[];
      };
    expect(schema("read_open_question").required).toEqual(["specId", "questionId"]);
    expect(schema("create_open_question").required).toEqual(["specId", "version", "body"]);
    expect(schema("create_open_question").properties.kind.enum).toEqual(["QUESTION", "ASSUMPTION"]);
    expect(schema("create_open_question").properties.sectionPath).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(schema("update_open_question").required).toEqual([
      "specId",
      "questionId",
      "version",
      "expectedUpdatedAt",
    ]);
    expect(schema("update_open_question").properties.answer).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(schema("update_open_question").properties.status.enum).toEqual([
      "OPEN",
      "RESOLVED",
      "DISMISSED",
    ]);
    expect(schema("update_open_question").properties).not.toHaveProperty("kind");
    expect(schema("delete_open_question").required).toEqual([
      "specId",
      "questionId",
      "version",
      "expectedUpdatedAt",
    ]);
    expect(schema("delete_open_question").properties.version.type).toBe("integer");
    await close();
  });

  it("keeps list_open_questions unchanged and the rest of the catalogue intact", async () => {
    const { mcp, close } = await connectTo(fetcherFor(new FakeKstonebaseApi([PRODUCT_SPEC])));
    const { tools } = await mcp.listTools();
    const list = tools.find((t) => t.name === "list_open_questions")!;
    expect(list.description).toBe(
      "List the questions and assumptions attached to a specification. Read-only. Resolved or dismissed items are excluded by default; pass includeResolved=true to surface the full set.",
    );
    expect(list.annotations).toEqual(CONTRACT_ANNOTATIONS.read_open_question);
    expect(list.inputSchema.properties).toEqual({
      specId: { type: "string", minLength: 1 },
      includeResolved: { type: "boolean" },
    });
    expect(list.inputSchema.required).toEqual(["specId"]);
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "append_context",
        "create_free_specification",
        "create_open_question",
        "create_product",
        "delete_open_question",
        "discard_draft",
        "find_product_by_subject",
        "init_product",
        "init_workspace",
        "list_open_questions",
        "list_products",
        "list_specification_changes",
        "list_specification_versions",
        "list_specifications",
        "list_workspaces",
        "read_open_question",
        "read_product",
        "read_specification",
        "read_specification_change",
        "read_specification_version",
        "read_workspace",
        "request_review",
        "search_specifications",
        "start_new_version",
        "update_open_question",
        "update_specification_content",
        "update_specification_section",
      ].sort(),
    );
    await close();
  });

  it("matches the annotations declared in the ChatGPT app manifest", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8"),
    ) as { tools: Record<string, { annotations: Record<string, boolean> }> };
    for (const name of Object.keys(CONTRACT_ANNOTATIONS)) {
      expect(manifest.tools, name).toHaveProperty(name);
    }
    const { mcp, close } = await connectTo(fetcherFor(new FakeKstonebaseApi([PRODUCT_SPEC])));
    const { tools } = await mcp.listTools();
    for (const [name, entry] of Object.entries(manifest.tools)) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.annotations, name).toEqual(entry.annotations);
    }
    await close();
  });

  it("reports the package version in serverInfo", async () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    const { mcp, close } = await connectTo(fetcherFor(new FakeKstonebaseApi([PRODUCT_SPEC])));
    expect(mcp.getServerVersion()).toMatchObject({ name: pkg.name, version: pkg.version });
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invocation forwarding
// ──────────────────────────────────────────────────────────────────────────

describe("open-question tools — invocation forwarding", () => {
  const QUESTION_FIXTURE = {
    question: {
      id: "q_1",
      specificationId: "s_1",
      kind: "QUESTION",
      body: "Who approves refunds?",
      answer: null,
      status: "OPEN",
      anchor: "7",
      resolvedAt: null,
      createdAt: "2026-09-26T18:04:05.1Z",
      updatedAt: "2026-09-26T18:04:05.123Z",
    },
    spec: { id: "s_1", version: 13, approvedVersion: 2, status: "DRAFT", openQuestionsCount: 1 },
  };
  const DELETE_FIXTURE = {
    deletedQuestionId: "q_1",
    spec: { id: "s_1", version: 15, approvedVersion: 2, status: "DRAFT", openQuestionsCount: 0 },
  };

  function stub(status: number, json: unknown) {
    return vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } }),
    );
  }

  function sent(fetcher: ReturnType<typeof stub>, i = 0) {
    const [url, init] = fetcher.mock.calls[i];
    return {
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
  }

  it("read_open_question → GET item path, result passed through unchanged", async () => {
    const fetcher = stub(200, QUESTION_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const data = await ok(mcp, "read_open_question", { specId: "s_1", questionId: "q_1" });
    expect(data).toEqual(QUESTION_FIXTURE);
    expect(sent(fetcher)).toMatchObject({
      url: `${API_URL}/api/mcp/specifications/s_1/open-questions/q_1`,
      method: "GET",
      body: undefined,
    });
    expect(sent(fetcher).headers.authorization).toBe(`Bearer ${TOKEN}`);
    await close();
  });

  it("create_open_question → POST with only the provided keys (kind defaults server-side)", async () => {
    const fetcher = stub(201, QUESTION_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const data = await ok(mcp, "create_open_question", {
      specId: "s_1",
      version: 12,
      body: "Who approves refunds?",
    });
    expect(data).toEqual(QUESTION_FIXTURE);
    expect(sent(fetcher)).toMatchObject({
      url: `${API_URL}/api/mcp/specifications/s_1/open-questions`,
      method: "POST",
      body: { version: 12, body: "Who approves refunds?" },
    });
    expect(Object.keys(sent(fetcher).body)).toEqual(["version", "body"]);
    await close();
  });

  it("create_open_question forwards kind and an explicit null sectionPath", async () => {
    const fetcher = stub(201, QUESTION_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    await ok(mcp, "create_open_question", {
      specId: "s_1",
      version: 12,
      body: "Refunds are approved by finance",
      kind: "ASSUMPTION",
      sectionPath: null,
    });
    expect(sent(fetcher).body).toEqual({
      version: 12,
      body: "Refunds are approved by finance",
      kind: "ASSUMPTION",
      sectionPath: null,
    });
    await close();
  });

  it("update_open_question → PATCH; null clears, omitted keeps, unknown keys never reach the API", async () => {
    const fetcher = stub(200, QUESTION_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    await ok(mcp, "update_open_question", {
      specId: "s_1",
      questionId: "q_1",
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.1Z",
      answer: null,
      sectionPath: null,
      kind: "ASSUMPTION",
    });
    expect(sent(fetcher)).toMatchObject({
      url: `${API_URL}/api/mcp/specifications/s_1/open-questions/q_1`,
      method: "PATCH",
    });
    expect(sent(fetcher).body).toEqual({
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.1Z",
      sectionPath: null,
      answer: null,
    });
    await close();
  });

  it("delete_open_question → DELETE with a JSON body; JSON result passed through", async () => {
    const fetcher = stub(200, DELETE_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const data = await ok(mcp, "delete_open_question", {
      specId: "s_1",
      questionId: "q_1",
      version: 14,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
    });
    expect(data).toEqual(DELETE_FIXTURE);
    expect(sent(fetcher)).toMatchObject({
      method: "DELETE",
      body: { version: 14, expectedUpdatedAt: "2026-09-26T18:04:05.123Z" },
    });
    expect(sent(fetcher).headers["content-type"]).toBe("application/json");
    await close();
  });

  it("rejects bad arguments before calling the API", async () => {
    const fetcher = stub(200, QUESTION_FIXTURE);
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    for (const [name, args] of [
      ["create_open_question", { specId: "s_1", version: 1.5, body: "b" }],
      ["create_open_question", { specId: "s_1", version: 1, body: "b", kind: "NOTE" }],
      ["update_open_question", { specId: "s_1", questionId: "q_1", version: 1, expectedUpdatedAt: "t", status: "CLOSED" }],
      ["delete_open_question", { specId: "s_1", questionId: "q_1", version: 1 }],
      ["delete_open_question", { specId: "s_1", questionId: "..", version: 1, expectedUpdatedAt: "t" }],
    ] as const) {
      const out = await callTool(mcp, name, args);
      expect(out.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(fetcher).not.toHaveBeenCalled();
    await close();
  });

  it("list_open_questions passes both the legacy and the additive list shape through", async () => {
    const legacy = {
      items: [
        {
          id: "q_1",
          kind: "QUESTION",
          body: "Who approves refunds?",
          answer: null,
          status: "OPEN",
          anchor: "7",
          createdAt: "2026-09-26T18:04:05.1Z",
          updatedAt: "2026-09-26T18:04:05.123Z",
        },
      ],
    };
    const current = { items: [QUESTION_FIXTURE.question], spec: QUESTION_FIXTURE.spec };
    for (const body of [legacy, current]) {
      const fetcher = stub(200, body);
      const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
      expect(await ok(mcp, "list_open_questions", { specId: "s_1" })).toEqual(body);
      expect(sent(fetcher).url).toBe(`${API_URL}/api/mcp/specifications/s_1/open-questions`);
      await close();
    }
  });

  it("returns a structured failure with remediation and details, and logs without the token", async () => {
    const fetcher = stub(409, {
      error: {
        code: "CONFLICT",
        message: "The question changed since you read it.",
        details: {
          code: "STALE_QUESTION",
          hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
        },
      },
    });
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const out = await failure(mcp, "update_open_question", {
      specId: "s_1",
      questionId: "q_1",
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
      status: "RESOLVED",
    });
    expect(out.data).toMatchObject({
      code: "STALE_QUESTION",
      message: "The question changed since you read it.",
      details: {
        hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
      },
    });
    expect(out.data.remediation).toContain("Re-read");
    expect(out.text.startsWith("STALE_QUESTION: The question changed since you read it.")).toBe(true);
    expect(out.text).toContain('Details: {"hint":"Re-read the question with read_open_question');
    expect(fetcher).toHaveBeenCalledOnce();

    const logged = stderrLines.join("");
    expect(logged).not.toContain(TOKEN);
    const line = stderrLines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.tool === "update_open_question");
    expect(line).toMatchObject({
      level: "warn",
      msg: "tool failed",
      errorCode: "STALE_QUESTION",
      specId: "s_1",
      questionId: "q_1",
    });
    await close();
  });

  it("reports a reopen whose heading is gone as NOT_FOUND with the reason and hint", async () => {
    const fetcher = stub(409, {
      error: {
        code: "CONFLICT",
        message: "The item's section no longer exists.",
        details: {
          code: "SECTION_NOT_FOUND",
          reason: "ANCHOR_STALE",
          hint: "Restore the heading, or delete the item and create it again.",
        },
      },
    });
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const out = await failure(mcp, "update_open_question", {
      specId: "s_1",
      questionId: "q_1",
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
      status: "OPEN",
    });
    expect(out.data).toMatchObject({
      code: "NOT_FOUND",
      message: "The item's section no longer exists.",
      details: {
        reason: "ANCHOR_STALE",
        hint: "Restore the heading, or delete the item and create it again.",
      },
    });
    expect(out.data.remediation).toContain("no longer exists");
    expect(out.text).toContain('"reason":"ANCHOR_STALE"');
    expect(fetcher).toHaveBeenCalledOnce();
    await close();
  });

  it("maps a network failure on a write to INTERNAL_ERROR telling the agent to re-read first", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const { mcp, close } = await connectTo(fetcher as unknown as typeof fetch);
    const out = await failure(mcp, "delete_open_question", {
      specId: "s_1",
      questionId: "q_1",
      version: 14,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
    });
    expect(out.data.code).toBe("INTERNAL_ERROR");
    expect(out.data.remediation).toContain("re-read the current state");
    expect(fetcher).toHaveBeenCalledOnce();
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Workflows (QUESTION and ASSUMPTION, Product and Workspace specs)
// ──────────────────────────────────────────────────────────────────────────

describe.each([
  { scope: "Product", spec: PRODUCT_SPEC, section: "## Refunds" },
  { scope: "Workspace", spec: WORKSPACE_SPEC, section: "## Decision" },
])("open-question workflows on a $scope specification", ({ spec, section }) => {
  function fresh() {
    return new FakeKstonebaseApi([{ ...spec }]);
  }
  const bothBound = makeConfig({
    workspaceId: "w_1",
    workspaceSource: "config-file",
    productId: "p_1",
    productSource: "config-file",
    bindingMode: "workspace+product",
  });

  it("QUESTION: create → list/read → edit/move → resolve → reopen → dismiss → delete", async () => {
    const api = fresh();
    const { mcp, close } = await connectTo(fetcherFor(api), bothBound);
    const specId = spec.id;

    const current = await ok(mcp, "read_specification", { specId });
    expect(current.version).toBe(spec.version);

    // Create (kind omitted → QUESTION).
    let res = await ok(mcp, "create_open_question", {
      specId,
      version: current.version,
      body: "  Who approves refunds?  ",
      sectionPath: section,
    });
    expect(res.question).toMatchObject({
      specificationId: specId,
      kind: "QUESTION",
      body: "Who approves refunds?",
      status: "OPEN",
      answer: null,
      resolvedAt: null,
      anchor: "3",
    });
    expect(res.spec).toMatchObject({ version: spec.version + 1, openQuestionsCount: 1 });
    expect(api.requests.at(-1)!.body).toEqual({
      version: spec.version,
      body: "  Who approves refunds?  ",
      sectionPath: section,
    });
    const questionId = res.question.id as string;
    // Go-style timestamp with trailing zeros dropped.
    expect(res.question.updatedAt).toBe("2026-09-26T18:04:05.11Z");

    // List and read agree with the create result.
    const list = await ok(mcp, "list_open_questions", { specId });
    expect(list.items).toEqual([res.question]);
    expect(list.spec).toEqual(res.spec);
    const read = await ok(mcp, "read_open_question", { specId, questionId });
    expect(read).toEqual({ question: res.question, spec: res.spec });

    // Edit the body and move it to the end of the document (null).
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: read.spec.version,
      expectedUpdatedAt: read.question.updatedAt,
      body: "Who approves refunds over 100 EUR?",
      sectionPath: null,
    });
    expect(res.question).toMatchObject({ body: "Who approves refunds over 100 EUR?", anchor: "5" });
    expect(res.spec.version).toBe(spec.version + 2);
    const edited = res;

    // A stale item token and a stale spec token are both rejected.
    let err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: edited.spec.version,
      expectedUpdatedAt: read.question.updatedAt,
      answer: "Finance",
    });
    expect(err.data.code).toBe("STALE_QUESTION");
    expect(err.data.details.hint).toContain("read_open_question");
    err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: read.spec.version,
      expectedUpdatedAt: edited.question.updatedAt,
      answer: "Finance",
    });
    expect(err.data.code).toBe("STALE_VERSION");

    // Save a draft answer (record only), then show that an explicit null
    // answer is not the same as an omitted one when resolving.
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: edited.spec.version,
      expectedUpdatedAt: edited.question.updatedAt,
      answer: "Finance approves refunds over 100 EUR.",
    });
    expect(res.question).toMatchObject({ status: "OPEN", answer: "Finance approves refunds over 100 EUR." });
    err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      answer: null,
      status: "RESOLVED",
    });
    expect(err.data.code).toBe("ANSWER_REQUIRED");
    expect(err.data.details.fields).toEqual(["answer is required to resolve a question"]);

    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "RESOLVED",
    });
    expect(res.question).toMatchObject({
      status: "RESOLVED",
      answer: "Finance approves refunds over 100 EUR.",
    });
    expect(res.question.resolvedAt).toEqual(expect.any(String));
    expect(res.spec.openQuestionsCount).toBe(0);
    expect(await ok(mcp, "list_open_questions", { specId })).toMatchObject({ items: [] });
    expect(
      (await ok(mcp, "list_open_questions", { specId, includeResolved: true })).items,
    ).toHaveLength(1);

    // Terminal items cannot be edited before a reopen.
    err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      body: "Changed after resolution",
    });
    expect(err.data.code).toBe("INVALID_TRANSITION");
    expect(err.data.details).toMatchObject({ from: "RESOLVED", to: "RESOLVED" });

    // Reopen (status OPEN alone): answer and resolvedAt cleared.
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "OPEN",
    });
    expect(res.question).toMatchObject({ status: "OPEN", answer: null, resolvedAt: null });

    // Dismiss: record only, resolvedAt stays null.
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "DISMISSED",
    });
    expect(res.question).toMatchObject({ status: "DISMISSED", resolvedAt: null });

    // Permanent delete.
    const versionBeforeDelete = res.spec.version;
    const deleted = await ok(mcp, "delete_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
    });
    expect(deleted).toEqual({
      deletedQuestionId: questionId,
      spec: expect.objectContaining({ version: versionBeforeDelete + 1, openQuestionsCount: 0 }),
    });
    const lastRequest = api.requests.at(-1)!;
    expect(lastRequest.method).toBe("DELETE");
    expect(lastRequest.body).toEqual({
      version: versionBeforeDelete,
      expectedUpdatedAt: res.question.updatedAt,
    });
    err = await failure(mcp, "read_open_question", { specId, questionId });
    expect(err.data).toMatchObject({ code: "NOT_FOUND", message: "Question not found." });

    // Every request carried only the Bearer token.
    for (const r of api.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.headers).not.toHaveProperty("cookie");
    }
    await close();
  });

  it("ASSUMPTION: create → resolve → no-op repeat → reopen → dismiss → delete", async () => {
    const api = fresh();
    const { mcp, close } = await connectTo(fetcherFor(api), bothBound);
    const specId = spec.id;
    const { version } = await ok(mcp, "read_specification", { specId });

    let res = await ok(mcp, "create_open_question", {
      specId,
      version,
      kind: "ASSUMPTION",
      body: "Refunds are approved by finance",
    });
    expect(res.question).toMatchObject({ kind: "ASSUMPTION", status: "OPEN", anchor: "5" });
    expect(api.requests.at(-1)!.body).toEqual({
      version,
      body: "Refunds are approved by finance",
      kind: "ASSUMPTION",
    });
    const questionId = res.question.id as string;

    // Answers belong to questions only; the API's field message comes through.
    let err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      answer: "Yes",
    });
    expect(err.data).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { fields: ["answer applies to questions only"] },
    });

    // Resolve: no answer needed for an assumption.
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "RESOLVED",
    });
    expect(res.question.status).toBe("RESOLVED");

    // Repeating the terminal status alone is a no-op: same tokens back.
    const again = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "RESOLVED",
    });
    expect(again).toEqual(res);

    // Terminal → other terminal needs a reopen first.
    err = await failure(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "DISMISSED",
    });
    expect(err.data).toMatchObject({
      code: "INVALID_TRANSITION",
      details: { from: "RESOLVED", to: "DISMISSED" },
    });

    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "OPEN",
    });
    expect(res.question.status).toBe("OPEN");
    res = await ok(mcp, "update_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
      status: "DISMISSED",
    });
    expect(res.question).toMatchObject({ status: "DISMISSED", resolvedAt: null });

    const deleted = await ok(mcp, "delete_open_question", {
      specId,
      questionId,
      version: res.spec.version,
      expectedUpdatedAt: res.question.updatedAt,
    });
    expect(deleted.deletedQuestionId).toBe(questionId);
    expect((await ok(mcp, "list_open_questions", { specId, includeResolved: true })).items).toEqual([]);
    await close();
  });

  it("surfaces section and marker conflicts with their details", async () => {
    const api = new FakeKstonebaseApi([
      { ...spec, headings: [...spec.headings, section] }, // duplicate heading
    ]);
    const { mcp, close } = await connectTo(fetcherFor(api), bothBound);
    const specId = spec.id;
    let { version } = await ok(mcp, "read_specification", { specId });

    let err = await failure(mcp, "create_open_question", {
      specId,
      version,
      body: "Where does this go?",
      sectionPath: "## Missing heading",
    });
    // Same tool code as the Website adapter; the details say it is a section.
    expect(err.data).toMatchObject({
      code: "NOT_FOUND",
      details: { sectionPath: "## Missing heading" },
    });
    expect(err.data.remediation).toContain("No heading matches sectionPath");

    err = await failure(mcp, "create_open_question", {
      specId,
      version,
      body: "Where does this go?",
      sectionPath: section,
    });
    expect(err.data).toMatchObject({ code: "SECTION_AMBIGUOUS", details: { sectionPath: section } });

    const created = await ok(mcp, "create_open_question", { specId, version, body: "Who signs off?" });
    version = created.spec.version;
    err = await failure(mcp, "create_open_question", { specId, version, body: "Who signs off?" });
    expect(err.data).toMatchObject({
      code: "MARKER_AMBIGUOUS",
      details: { reason: "DUPLICATE_IN_SECTION" },
    });

    api.removeMarker(created.question.id);
    err = await failure(mcp, "update_open_question", {
      specId,
      questionId: created.question.id,
      version,
      expectedUpdatedAt: created.question.updatedAt,
      answer: "The owner",
      status: "RESOLVED",
    });
    expect(err.data.code).toBe("MARKER_NOT_FOUND");
    expect(err.data.details.hint).toContain("restore the marker text or delete the question");
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Binding and credential scope
// ──────────────────────────────────────────────────────────────────────────

describe("open-question tools — Product and Workspace scope", () => {
  const BINDINGS: Array<{ name: string; config: Partial<ResolvedConfig> }> = [
    { name: "discovery", config: {} },
    {
      name: "product",
      config: { productId: "p_1", productSource: "config-file", bindingMode: "product" },
    },
    {
      name: "workspace",
      config: { workspaceId: "w_1", workspaceSource: "env", bindingMode: "workspace" },
    },
    {
      name: "workspace+product",
      config: {
        workspaceId: "w_1",
        workspaceSource: "config-file",
        productId: "p_1",
        productSource: "config-file",
        bindingMode: "workspace+product",
      },
    },
  ];

  async function scriptedRun(config: ResolvedConfig) {
    const api = new FakeKstonebaseApi([{ ...PRODUCT_SPEC }, { ...WORKSPACE_SPEC }]);
    const { mcp, close } = await connectTo(fetcherFor(api), config);
    for (const spec of [PRODUCT_SPEC, WORKSPACE_SPEC]) {
      const created = await ok(mcp, "create_open_question", {
        specId: spec.id,
        version: spec.version,
        body: "Who owns this?",
      });
      const read = await ok(mcp, "read_open_question", {
        specId: spec.id,
        questionId: created.question.id,
      });
      const updated = await ok(mcp, "update_open_question", {
        specId: spec.id,
        questionId: created.question.id,
        version: read.spec.version,
        expectedUpdatedAt: read.question.updatedAt,
        answer: "The platform team",
        status: "RESOLVED",
      });
      await ok(mcp, "delete_open_question", {
        specId: spec.id,
        questionId: created.question.id,
        version: updated.spec.version,
        expectedUpdatedAt: updated.question.updatedAt,
      });
    }
    await close();
    return api.requests;
  }

  it("sends the same requests whatever the binding: specId addresses the spec", async () => {
    const runs = [];
    for (const binding of BINDINGS) {
      runs.push(await scriptedRun(makeConfig(binding.config)));
    }
    for (const run of runs.slice(1)) expect(run).toEqual(runs[0]);
    expect(runs[0].map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/mcp/specifications/s_prod/open-questions",
      "GET /api/mcp/specifications/s_prod/open-questions/q_1",
      "PATCH /api/mcp/specifications/s_prod/open-questions/q_1",
      "DELETE /api/mcp/specifications/s_prod/open-questions/q_1",
      "POST /api/mcp/specifications/s_ws/open-questions",
      "GET /api/mcp/specifications/s_ws/open-questions/q_2",
      "PATCH /api/mcp/specifications/s_ws/open-questions/q_2",
      "DELETE /api/mcp/specifications/s_ws/open-questions/q_2",
    ]);
    for (const r of runs[0]) {
      expect(JSON.stringify(r.body ?? {})).not.toMatch(/productId|workspaceId/);
    }
  });

  it("passes TOKEN_SCOPE_MISMATCH through for a spec outside the credential's allowlist", async () => {
    const api = new FakeKstonebaseApi([{ ...PRODUCT_SPEC }, { ...WORKSPACE_SPEC }], {
      allowlist: ["product:p_1"],
    });
    const { mcp, close } = await connectTo(fetcherFor(api));
    await ok(mcp, "list_open_questions", { specId: PRODUCT_SPEC.id });
    const err = await failure(mcp, "create_open_question", {
      specId: WORKSPACE_SPEC.id,
      version: WORKSPACE_SPEC.version,
      body: "Out of scope?",
    });
    expect(err.data.code).toBe("TOKEN_SCOPE_MISMATCH");
    await close();
  });

  it("keeps the existing vocabulary for a read-only credential", async () => {
    // Spec §6: credential/auth failures keep their pre-existing codes, so the
    // API's FORBIDDEN + TOKEN_SCOPE_INSUFFICIENT still reports
    // TOKEN_SCOPE_MISMATCH; the message names the exact reason.
    const api = new FakeKstonebaseApi([{ ...PRODUCT_SPEC }], { writeScope: false });
    const { mcp, close } = await connectTo(fetcherFor(api));
    await ok(mcp, "list_open_questions", { specId: PRODUCT_SPEC.id });
    const err = await failure(mcp, "create_open_question", {
      specId: PRODUCT_SPEC.id,
      version: PRODUCT_SPEC.version,
      body: "Can I write?",
    });
    expect(err.data).toEqual({
      code: "TOKEN_SCOPE_MISMATCH",
      message: "TOKEN_SCOPE_INSUFFICIENT",
      remediation:
        "The token isn't scoped to this product. Use a token whose allowlist includes it, or remove the allowlist.",
    });
    await close();
  });

  it("answers an open question of a Needs Review or Reviewed spec: the spec comes back as a Draft (contract §11)", async () => {
    for (const status of ["NEEDS_REVIEW", "REVIEWED"] as const) {
      const api = new FakeKstonebaseApi([{ ...PRODUCT_SPEC }]);
      const { mcp, close } = await connectTo(fetcherFor(api));
      const created = await ok(mcp, "create_open_question", {
        specId: PRODUCT_SPEC.id,
        version: PRODUCT_SPEC.version,
        body: "Who approves refunds?",
      });
      api.setStatus(PRODUCT_SPEC.id, status);
      const tokens = {
        specId: PRODUCT_SPEC.id,
        questionId: created.question.id,
        version: created.spec.version,
        expectedUpdatedAt: created.question.updatedAt,
      };

      const dismissed = await failure(mcp, "update_open_question", { ...tokens, status: "DISMISSED" });
      expect(dismissed.data).toMatchObject({ code: "SPEC_LOCKED", details: { status } });
      expect(dismissed.data.remediation).toMatch(/update_open_question with only the answer and status RESOLVED \(a question\)/);

      const answered = await ok(mcp, "update_open_question", { ...tokens, answer: "Finance.", status: "RESOLVED" });
      expect(answered.question).toMatchObject({ status: "RESOLVED", answer: "Finance." });
      expect(answered.spec).toMatchObject({ status: "DRAFT", version: tokens.version + 1, approvedVersion: 2 });
      await close();
    }
  });

  it("accepts or rejects an open assumption of a Needs Review or Reviewed spec: the spec comes back as a Draft (contract §11, 2026-09-26)", async () => {
    for (const [status, decision] of [
      ["NEEDS_REVIEW", "RESOLVED"],
      ["REVIEWED", "DISMISSED"],
    ] as const) {
      const api = new FakeKstonebaseApi([{ ...PRODUCT_SPEC }]);
      const { mcp, close } = await connectTo(fetcherFor(api));
      const created = await ok(mcp, "create_open_question", {
        specId: PRODUCT_SPEC.id,
        version: PRODUCT_SPEC.version,
        body: "Refunds are rare",
        kind: "ASSUMPTION",
      });
      api.setStatus(PRODUCT_SPEC.id, status);
      const tokens = {
        specId: PRODUCT_SPEC.id,
        questionId: created.question.id,
        version: created.spec.version,
        expectedUpdatedAt: created.question.updatedAt,
      };

      // A body change is not a settling request: still locked.
      const edited = await failure(mcp, "update_open_question", { ...tokens, status: decision, body: "Refunds are common" });
      expect(edited.data).toMatchObject({ code: "SPEC_LOCKED", details: { status } });
      expect(edited.data.remediation).toMatch(/only status RESOLVED or DISMISSED \(an assumption\)/);

      const settled = await ok(mcp, "update_open_question", { ...tokens, status: decision });
      expect(settled.question).toMatchObject({ kind: "ASSUMPTION", status: decision });
      expect(settled.spec).toMatchObject({ status: "DRAFT", version: tokens.version + 1, approvedVersion: 2 });
      await close();
    }
  });

  it("keeps lifecycle errors actionable: Needs Review, Reviewed and archived specs", async () => {
    const api = new FakeKstonebaseApi([
      { ...PRODUCT_SPEC, id: "s_review", status: "NEEDS_REVIEW" },
      { ...PRODUCT_SPEC, id: "s_reviewed", status: "REVIEWED" },
      { ...WORKSPACE_SPEC, id: "s_archived", archived: true },
    ]);
    const { mcp, close } = await connectTo(fetcherFor(api));

    let err = await failure(mcp, "create_open_question", {
      specId: "s_review",
      version: PRODUCT_SPEC.version,
      body: "b",
    });
    expect(err.data).toMatchObject({ code: "SPEC_LOCKED", details: { status: "NEEDS_REVIEW" } });
    expect(err.data.remediation).toContain("does not unlock");
    expect(err.data.remediation).not.toMatch(/call start_new_version/i);

    err = await failure(mcp, "create_open_question", {
      specId: "s_reviewed",
      version: PRODUCT_SPEC.version,
      body: "b",
    });
    expect(err.data).toMatchObject({ code: "SPEC_LOCKED", details: { status: "REVIEWED" } });
    expect(err.data.remediation).toContain("Call start_new_version");
    expect(err.data.remediation).toContain("Answering an open question or accepting or rejecting an open assumption needs no new version");

    err = await failure(mcp, "create_open_question", {
      specId: "s_archived",
      version: WORKSPACE_SPEC.version,
      body: "b",
    });
    expect(err.data).toMatchObject({
      code: "SPEC_ARCHIVED",
      details: { hint: "restore the spec first" },
    });
    await close();
  });
});
