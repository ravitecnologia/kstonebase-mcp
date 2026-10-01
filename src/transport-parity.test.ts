// Cross-transport parity (Kstonebase MCP spec "mcp-server" §3 "tool schemas
// are byte-identical to the stdio surface"; "mcp-open-question-management"
// §7.8; "mcp-board-tools" §2.1). The same scripted open-question and native
// Board session runs over:
//   * an in-memory transport against buildServer(),
//   * the real --http transport (startHttpServer),
//   * the real stdio CLI, spawned as a child process (src/cli.ts via tsx),
// all pointed at a loopback stub of the Kstonebase API. The advertised tool
// lists, the tool results and the HTTP requests reaching the API must match.

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

const BOARD_STALE_ERROR = {
  error: {
    code: "CONFLICT",
    message: "The work item changed since you read it.",
    details: { code: "STALE_VERSION", currentVersion: 2, item: { id: "bi_1", version: 2 } },
  },
};

interface SeenRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  cookie: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

function route(method: string, path: string): { status: number; json: unknown } {
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
];

/** The scripted session every transport runs. */
async function runSession(client: Client): Promise<SessionRecord> {
  seen = [];
  const { tools } = await client.listTools();
  const results: unknown[] = [];
  const calls: Array<[string, Record<string, unknown>]> = [
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
    ["create_board_item", { workspaceId: "ws_1", type: "epic", title: "Board", idempotencyKey: "parity-create-1" }],
    ["update_board_item", { workspaceId: "ws_1", itemId: "bi_1", expectedVersion: 1, assigneeId: null, state: "doing" }],
    ["unlink_board_specification", { workspaceId: "ws_1", itemId: "bi_1", specificationId: "s_1", expectedVersion: 2 }],
    ["read_board", {}],
  ];
  for (const [name, args] of calls) {
    const res = await client.callTool({ name, arguments: args });
    results.push({ isError: res.isError ?? false, structuredContent: res.structuredContent, content: res.content });
  }
  return { tools, results, requests: [...seen] };
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
      for (const name of [...OPEN_QUESTION_TOOLS, ...BOARD_TOOLS]) expect(names).toContain(name);

      // Same results, including the structured STALE_QUESTION failure.
      expect(http.results).toEqual(memory.results);
      expect(stdio.results).toEqual(memory.results);
      expect(memory.results[1]).toMatchObject({ isError: false, structuredContent: QUESTION_FIXTURE });
      expect(memory.results[2]).toMatchObject({ isError: false, structuredContent: QUESTION_FIXTURE });
      expect(memory.results[3]).toMatchObject({
        isError: true,
        structuredContent: {
          code: "STALE_QUESTION",
          details: { hint: STALE_QUESTION_ERROR.error.details.hint },
        },
      });
      expect(memory.results[4]).toMatchObject({ isError: false, structuredContent: DELETE_FIXTURE });
      expect(memory.results[5]).toMatchObject({ isError: false, structuredContent: { total: 1, items: [BOARD_ITEM_FIXTURE] } });
      expect(memory.results[6]).toMatchObject({ isError: false, structuredContent: { item: BOARD_ITEM_FIXTURE, replayed: false } });
      expect(memory.results[7]).toMatchObject({
        isError: true,
        structuredContent: { code: "STALE_VERSION", details: { currentVersion: 2 } },
      });
      expect(memory.results[8]).toMatchObject({ isError: false, structuredContent: BOARD_ITEM_FIXTURE });
      // No Workspace binding: read_board fails locally on every transport.
      expect(memory.results[9]).toMatchObject({ isError: true, structuredContent: { code: "WORKSPACE_NOT_BOUND" } });

      // Same requests at the API: one per call, no retries, Bearer only.
      expect(http.requests).toEqual(memory.requests);
      expect(stdio.requests).toEqual(memory.requests);
      expect(memory.requests).toEqual([
        {
          method: "GET",
          path: "/api/mcp/specifications/s_1/open-questions",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        {
          method: "GET",
          path: "/api/mcp/specifications/s_1/open-questions/q_1",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        {
          method: "POST",
          path: "/api/mcp/specifications/s_1/open-questions",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { version: 12, body: "Who approves refunds?", sectionPath: null },
        },
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
        {
          method: "GET",
          path: "/api/mcp/workspaces/ws_1/board/items?type=epic&q=Board&limit=5",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: undefined,
          body: undefined,
        },
        {
          method: "POST",
          path: "/api/mcp/workspaces/ws_1/board/items",
          authorization: `Bearer ${TOKEN}`,
          cookie: undefined,
          contentType: "application/json",
          body: { type: "epic", title: "Board", idempotencyKey: "parity-create-1" },
        },
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
      ]);
    },
    60_000,
  );
});
