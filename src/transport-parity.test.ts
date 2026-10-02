// Cross-transport parity (Kstonebase MCP spec "mcp-server" §3 "tool schemas
// are byte-identical to the stdio surface"; "mcp-open-question-management"
// §7.8; "mcp-board-tools" §2.1; "workspace-agent-instructions", frozen
// contract PBI 176). The same scripted open-question, native Board and
// Workspace-instructions session runs over:
//   * an in-memory transport against buildServer(),
//   * the real --http transport (startHttpServer),
//   * the real stdio CLI, spawned as a child process (src/cli.ts via tsx),
// all pointed at a loopback stub of the Kstonebase API. The advertised tool
// lists, the server instructions, the tool results (policy notices and
// `_meta` included) and the HTTP requests reaching the API must match.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ResolvedConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_PARITY_TEST";

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

const STALE_QUESTION_ERROR = {
  error: {
    code: "CONFLICT",
    message: "The question changed since you read it.",
    details: {
      code: "STALE_QUESTION",
      hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
    },
  },
};

// Native Board fixtures (MCP › mcp-board-tools.md §2.1; API DTOs §9.5).
const BOARD_ITEM_FIXTURE = {
  id: "bi_1",
  workspaceId: "ws_1",
  displayNumber: 1,
  type: "epic",
  parentId: null,
  parent: null,
  state: "to_do",
  title: "Board",
  priority: 2,
  tags: [],
  assignee: null,
  product: null,
  childCounts: { total: 0, done: 0 },
  specifications: [{ specificationId: "s_gone", available: false }],
  version: 1,
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:00:00Z",
  description: "",
  acceptanceCriteria: "",
  implementationPrompt: "",
  createdBy: null,
  notes: [],
  notesTotal: 0,
};

// Import report fixtures (MCP › mcp-board-tools.md §2.2; API import contract §8.8).
const BOARD_IMPORT_FIXTURE = {
  id: "run_1",
  workspaceId: "ws_1",
  provider: "azure_devops",
  providerLabel: "Azure DevOps",
  phase: "preview",
  status: "needs_mapping",
  plan: { import: 0, already_imported: 0, unsupported: 0, excluded: 0, blocked: 1 },
  items: [{ sourceId: 42, plan: "blocked", planCode: "state-unmapped", outcome: null, nativeItem: null }],
  itemsTotal: 1,
  limit: 10,
  nextCursor: null,
};

const BOARD_OWNER_REQUIRED_ERROR = {
  error: { code: "FORBIDDEN", message: "Only the Workspace Owner can do this.", details: { code: "OWNER_REQUIRED" } },
};

const BOARD_STALE_ERROR = {
  error: {
    code: "CONFLICT",
    message: "The work item changed since you read it.",
    details: { code: "STALE_VERSION", currentVersion: 2, item: { id: "bi_1", version: 2 } },
  },
};

// Effective Workspace instructions (API resolver, frozen contract PBI 174):
// ws_1 is in Workspace mode, the specification s_1 resolves Local.
const WS_REVISION = "wp1_WsPolicyRevision000001";
const SPEC_REVISION = "wp1_LocalSpecRevision00001";
const WS_INSTRUCTIONS = "Run the delivery checklist before every Board change.";

const WS_POLICY = {
  schemaVersion: 1,
  mode: "workspace",
  source: "workspace_policy",
  policyRevision: WS_REVISION,
  instructions: WS_INSTRUCTIONS,
  instructionsOmitted: false,
};

const SPEC_POLICY = {
  schemaVersion: 1,
  mode: "local",
  source: "workspace_local",
  policyRevision: SPEC_REVISION,
  instructions: null,
  instructionsOmitted: false,
};

const WS_NOTICE = [
  `[Kstonebase Workspace instructions | target workspace:ws_1 | mode workspace | source workspace_policy | revision ${WS_REVISION}]`,
  `These verified Workspace instructions govern this resource. They take priority over local AGENTS.md/CLAUDE.md, which only supplement them, and they never grant permissions. Pass expectedPolicyRevision "${WS_REVISION}" on writes to this resource.`,
  "----- BEGIN WORKSPACE INSTRUCTIONS -----",
  WS_INSTRUCTIONS,
  "----- END WORKSPACE INSTRUCTIONS -----",
].join("\n");

const SPEC_NOTICE = [
  `[Kstonebase Workspace instructions | target specification:s_1 | mode local | source workspace_local | revision ${SPEC_REVISION}]`,
  `No Workspace instructions are enabled for this resource. Follow the applicable local AGENTS.md/CLAUDE.md within platform rules. Pass expectedPolicyRevision "${SPEC_REVISION}" on writes to this resource.`,
].join("\n");

function agentPolicy(path: string): { status: number; json: unknown } {
  const url = new URL(path, "http://stub.invalid");
  const omit = url.searchParams.get("instructions") === "omit";
  const items = url.searchParams.getAll("target").map((t) => {
    const [type, ...rest] = t.split(":");
    const target = { type, id: rest.join(":") };
    if (t === "workspace:ws_1") {
      return {
        target,
        policy: omit ? { ...WS_POLICY, instructions: null, instructionsOmitted: true } : WS_POLICY,
      };
    }
    if (t === "specification:s_1") return { target, policy: SPEC_POLICY };
    return { target, error: { code: "NOT_FOUND" } };
  });
  return { status: 200, json: { items } };
}

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  cookie: string | undefined;
  contentType: string | undefined;
  /** X-Kstonebase-Policy-Revision; only present when the agent passed one. */
  policyRevision?: string;
  body: unknown;
}

function route(method: string, path: string): { status: number; json: unknown } {
  if (method === "GET" && path.startsWith("/api/mcp/agent-policy?")) return agentPolicy(path);
  const collection = "/api/mcp/specifications/s_1/open-questions";
  const item = `${collection}/q_1`;
  if (method === "GET" && path === collection) {
    return { status: 200, json: { items: [QUESTION_FIXTURE.question], spec: QUESTION_FIXTURE.spec } };
  }
  if (method === "POST" && path === collection) return { status: 201, json: QUESTION_FIXTURE };
  if (method === "GET" && path === item) return { status: 200, json: QUESTION_FIXTURE };
  if (method === "PATCH" && path === item) return { status: 409, json: STALE_QUESTION_ERROR };
  if (method === "DELETE" && path === item) return { status: 200, json: DELETE_FIXTURE };
  const board = "/api/mcp/workspaces/ws_1/board";
  if (method === "GET" && path === `${board}/items?type=epic&q=Board&limit=5`) {
    return { status: 200, json: { items: [BOARD_ITEM_FIXTURE], total: 1, counts: { to_do: 1, doing: 0, done: 0 }, limit: 5, nextCursor: null } };
  }
  if (method === "POST" && path === `${board}/items`) return { status: 201, json: { item: BOARD_ITEM_FIXTURE, replayed: false } };
  if (method === "PATCH" && path === `${board}/items/bi_1`) return { status: 409, json: BOARD_STALE_ERROR };
  if (method === "DELETE" && path === `${board}/items/bi_1/specifications/s_1`) return { status: 200, json: BOARD_ITEM_FIXTURE };
  if (method === "GET" && path === `${board}/imports/run_1?limit=10&plan=blocked`) return { status: 200, json: BOARD_IMPORT_FIXTURE };
  if (method === "GET" && path === `${board}/imports`) return { status: 403, json: BOARD_OWNER_REQUIRED_ERROR };
  return { status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } };
}

let stubApi: Server;
let apiUrl = "";
let seen: SeenRequest[] = [];
let workDir = "";

beforeAll(async () => {
  // In-process transports log to stderr; keep the test output clean.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  workDir = mkdtempSync(join(tmpdir(), "kstonebase-mcp-parity-"));
  stubApi = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      seen.push({
        method,
        path,
        authorization: req.headers.authorization,
        cookie: req.headers.cookie,
        contentType: req.headers["content-type"],
        policyRevision: req.headers["x-kstonebase-policy-revision"] as string | undefined,
        body: raw.length > 0 ? JSON.parse(raw) : undefined,
      });
      const reply = route(method, path);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => stubApi.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(stubApi.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => stubApi.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function config(): ResolvedConfig {
  return {
    apiUrl,
    apiUrlSource: "env",
    token: TOKEN,
    workspaceId: null,
    workspaceSource: "none",
    productId: null,
    productSource: "none",
    bindingMode: "discovery",
    telemetryEnabled: false,
    allowInsecure: false,
  };
}

interface SessionRecord {
  instructions: string | undefined;
  tools: unknown[];
  results: unknown[];
  requests: SeenRequest[];
}

const OPEN_QUESTION_TOOLS = [
  "list_open_questions",
  "read_open_question",
  "create_open_question",
  "update_open_question",
  "delete_open_question",
];

const BOARD_TOOLS = [
  "read_board",
  "list_board_items",
  "read_board_item",
  "list_board_item_notes",
  "create_board_item",
  "update_board_item",
  "link_board_specification",
  "unlink_board_specification",
  "append_board_item_note",
  "archive_board_item",
  "restore_board_item",
  "list_board_imports",
  "read_board_import",
];

/** The scripted session every transport runs. */
async function runSession(client: Client): Promise<SessionRecord> {
  seen = [];
  const { tools } = await client.listTools();
  const results: unknown[] = [];
  const calls: Array<[string, Record<string, unknown>]> = [
    ["get_effective_instructions", { workspaceId: "ws_1" }],
    ["list_open_questions", { specId: "s_1" }],
    ["read_open_question", { specId: "s_1", questionId: "q_1" }],
    ["create_open_question", { specId: "s_1", version: 12, body: "Who approves refunds?", sectionPath: null }],
    [
      "update_open_question",
      {
        specId: "s_1",
        questionId: "q_1",
        version: 13,
        expectedUpdatedAt: "2026-09-26T18:04:05.1Z",
        answer: "Finance",
        status: "RESOLVED",
      },
    ],
    [
      "delete_open_question",
      { specId: "s_1", questionId: "q_1", version: 14, expectedUpdatedAt: "2026-09-26T18:04:05.123Z" },
    ],
    // Native Board tools: no binding in these sessions, so workspaceId is explicit.
    ["list_board_items", { workspaceId: "ws_1", type: "epic", query: "Board", limit: 5 }],
    [
      "create_board_item",
      { workspaceId: "ws_1", type: "epic", title: "Board", idempotencyKey: "parity-create-1", expectedPolicyRevision: WS_REVISION },
    ],
    ["update_board_item", { workspaceId: "ws_1", itemId: "bi_1", expectedVersion: 1, assigneeId: null, state: "doing" }],
    ["unlink_board_specification", { workspaceId: "ws_1", itemId: "bi_1", specificationId: "s_1", expectedVersion: 2 }],
    ["read_board", {}],
    ["read_board_import", { workspaceId: "ws_1", importId: "run_1", plan: "blocked", limit: 10 }],
    ["list_board_imports", { workspaceId: "ws_1" }],
  ];
  for (const [name, args] of calls) {
    const res = await client.callTool({ name, arguments: args });
    results.push({
      isError: res.isError ?? false,
      structuredContent: res.structuredContent,
      content: res.content,
      _meta: res._meta,
    });
  }
  return { instructions: client.getInstructions(), tools, results, requests: [...seen] };
}

async function inMemorySession(): Promise<SessionRecord> {
  const server = buildServer({ config: config() });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "parity-in-memory", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    return await runSession(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function httpSession(): Promise<SessionRecord> {
  const handle = await startHttpServer({ config: config(), port: 0, host: "127.0.0.1" });
  const client = new Client({ name: "parity-http", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
  );
  try {
    return await runSession(client);
  } finally {
    await client.close();
    await handle.close();
  }
}

async function stdioSession(): Promise<SessionRecord> {
  const require = createRequire(import.meta.url);
  const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
  const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const client = new Client({ name: "parity-stdio", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", tsxLoader, cliPath],
      // An empty working directory: no .kstonebase.json binding.
      cwd: workDir,
      env: {
        KSTONEBASE_API_TOKEN: TOKEN,
        KSTONEBASE_API_URL: apiUrl,
        KSTONEBASE_LOG_LEVEL: "error",
        KSTONEBASE_TELEMETRY: "0",
      },
      stderr: "pipe",
    }),
  );
  try {
    return await runSession(client);
  } finally {
    await client.close();
  }
}

describe("stdio and HTTP transports", () => {
  it(
    "advertise the same tools and forward open-question and Board calls identically",
    async () => {
      const memory = await inMemorySession();
      const http = await httpSession();
      const stdio = await stdioSession();

      // Same catalogue, byte for byte, on every transport.
      expect(JSON.stringify(http.tools)).toBe(JSON.stringify(memory.tools));
      expect(JSON.stringify(stdio.tools)).toBe(JSON.stringify(memory.tools));
      const names = (memory.tools as Array<{ name: string }>).map((t) => t.name);
      for (const name of [...OPEN_QUESTION_TOOLS, ...BOARD_TOOLS, "get_effective_instructions"]) {
        expect(names).toContain(name);
      }

      // Same server instructions on every transport (decision M5).
      expect(memory.instructions).toMatch(/^Kstonebase results about a Workspace, Product or specification end with/);
      expect(http.instructions).toBe(memory.instructions);
      expect(stdio.instructions).toBe(memory.instructions);

      // Same results, including the structured STALE_QUESTION failure and
      // the policy notices.
      expect(http.results).toEqual(memory.results);
      expect(stdio.results).toEqual(memory.results);
      const wsMeta = {
        "kstonebase.com/policy": {
          target: { type: "workspace", id: "ws_1" },
          mode: "workspace",
          source: "workspace_policy",
          policyRevision: WS_REVISION,
          instructionsIncluded: true,
        },
      };
      const specMeta = {
        "kstonebase.com/policy": {
          target: { type: "specification", id: "s_1" },
          mode: "local",
          source: "workspace_local",
          policyRevision: SPEC_REVISION,
          instructionsIncluded: false,
        },
      };
      const withNotice = (structuredContent: unknown, notice: string, meta: unknown) => ({
        isError: false,
        structuredContent,
        content: [
          { type: "text", text: JSON.stringify(structuredContent, null, 2) },
          { type: "text", text: notice },
        ],
        _meta: meta,
      });
      expect(memory.results[0]).toEqual(
        withNotice({ target: { type: "workspace", id: "ws_1" }, policy: WS_POLICY }, WS_NOTICE, wsMeta),
      );
      expect(memory.results[2]).toEqual(withNotice(QUESTION_FIXTURE, SPEC_NOTICE, specMeta));
      expect(memory.results[3]).toEqual(withNotice(QUESTION_FIXTURE, SPEC_NOTICE, specMeta));
      expect(memory.results[4]).toMatchObject({
        isError: true,
        structuredContent: {
          code: "STALE_QUESTION",
          details: { hint: STALE_QUESTION_ERROR.error.details.hint },
        },
      });
      expect(memory.results[5]).toEqual(withNotice(DELETE_FIXTURE, SPEC_NOTICE, specMeta));
      expect(memory.results[6]).toMatchObject({ isError: false, structuredContent: { total: 1, items: [BOARD_ITEM_FIXTURE] } });
      // The cached Workspace text fills the notice when the resolver omits it.
      expect((memory.results[6] as { content: unknown[] }).content[1]).toEqual({ type: "text", text: WS_NOTICE });
      expect(memory.results[7]).toEqual(withNotice({ item: BOARD_ITEM_FIXTURE, replayed: false }, WS_NOTICE, wsMeta));
      expect(memory.results[8]).toMatchObject({
        isError: true,
        structuredContent: { code: "STALE_VERSION", details: { currentVersion: 2 } },
      });
      expect(memory.results[9]).toEqual(withNotice(BOARD_ITEM_FIXTURE, WS_NOTICE, wsMeta));
      // No Workspace binding: read_board fails locally on every transport.
      expect(memory.results[10]).toMatchObject({ isError: true, structuredContent: { code: "WORKSPACE_NOT_BOUND" } });
      // Import report reads: RunDetail unchanged; a Member's report read is OWNER_REQUIRED.
      expect(memory.results[11]).toEqual(withNotice(BOARD_IMPORT_FIXTURE, WS_NOTICE, wsMeta));
      expect(memory.results[12]).toMatchObject({ isError: true, structuredContent: { code: "OWNER_REQUIRED" } });
      // Failed results carry no notice and no policy _meta.
      for (const i of [4, 8, 10, 12]) {
        const failed = memory.results[i] as { content: unknown[]; _meta?: unknown };
        expect(failed.content).toHaveLength(1);
        expect(failed._meta).toBeUndefined();
      }

      // Same requests at the API: one per call plus one fresh resolver call
      // after each successful scoped call, no retries, Bearer only; the
      // policy revision travels only as a header on the write that passed it.
      expect(http.requests).toEqual(memory.requests);
      expect(stdio.requests).toEqual(memory.requests);
      const policyGet = (target: string, omit = false) => ({
        method: "GET",
        path: `/api/mcp/agent-policy?target=${encodeURIComponent(target)}${omit ? "&instructions=omit" : ""}`,
        authorization: `Bearer ${TOKEN}`,
        cookie: undefined,
        contentType: undefined,
        body: undefined,
      });
      expect(memory.requests).toEqual([
        policyGet("workspace:ws_1"),
        {
          method: "GET",
          path: "/api/mcp/specifications/s_1/open-questions",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        policyGet("specification:s_1"),
        {
          method: "GET",
          path: "/api/mcp/specifications/s_1/open-questions/q_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        policyGet("specification:s_1"),
        {
          method: "POST",
          path: "/api/mcp/specifications/s_1/open-questions",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { version: 12, body: "Who approves refunds?", sectionPath: null },
        },
        policyGet("specification:s_1"),
        {
          method: "PATCH",
          path: "/api/mcp/specifications/s_1/open-questions/q_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: {
            version: 13,
            expectedUpdatedAt: "2026-09-26T18:04:05.1Z",
            answer: "Finance",
            status: "RESOLVED",
          },
        },
        {
          method: "DELETE",
          path: "/api/mcp/specifications/s_1/open-questions/q_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { version: 14, expectedUpdatedAt: "2026-09-26T18:04:05.123Z" },
        },
        policyGet("specification:s_1"),
        {
          method: "GET",
          path: "/api/mcp/workspaces/ws_1/board/items?type=epic&q=Board&limit=5",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        policyGet("workspace:ws_1", true),
        {
          method: "POST",
          path: "/api/mcp/workspaces/ws_1/board/items",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          policyRevision: WS_REVISION,
          body: { type: "epic", title: "Board", idempotencyKey: "parity-create-1" },
        },
        policyGet("workspace:ws_1", true),
        {
          method: "PATCH",
          path: "/api/mcp/workspaces/ws_1/board/items/bi_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { expectedVersion: 1, assigneeId: null, state: "doing" },
        },
        {
          method: "DELETE",
          path: "/api/mcp/workspaces/ws_1/board/items/bi_1/specifications/s_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { expectedVersion: 2 },
        },
        policyGet("workspace:ws_1", true),
        {
          method: "GET",
          path: "/api/mcp/workspaces/ws_1/board/imports/run_1?limit=10&plan=blocked",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        policyGet("workspace:ws_1", true),
        {
          method: "GET",
          path: "/api/mcp/workspaces/ws_1/board/imports",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
      ]);
      expect(memory.requests.filter((r) => r.policyRevision !== undefined)).toHaveLength(1);
    },
    60_000,
  );
});
