// Contract tests for the native Board tools (Kstonebase MCP spec
// "mcp-board-tools" §2.1–§4, backed by API › features/workspace-board.md §9).
// The server is built exactly as both transports build it (buildServer) and
// driven by the SDK client over an in-memory transport, against a recording
// stub of the API's /api/mcp/workspaces/:id/board… routes. These tests prove
// what the package owns — discovery, Workspace targeting, argument
// forwarding, result passthrough and error mapping. Board behaviour itself is
// the API's (see the real-API fixture recorded on PBI 410).

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_BOARD_TOOL_TEST";
const API_URL = "https://api.kstonebase.test";

// ──────────────────────────────────────────────────────────────────────────
// Contract literals (MCP › mcp-board-tools.md §2.1), kept independent of
// tools.ts so any drift fails here.
// ──────────────────────────────────────────────────────────────────────────

const SPEC_SENTENCE =
  "Completing or linking work items never changes or approves specifications.";

const CONTRACT: Record<
  string,
  { title: string; description: string; annotations: Record<string, boolean> }
> = {
  read_board: {
    title: "Read a Workspace Board",
    description:
      "Read the native Board of a Software Engineering Workspace: your role, capabilities, states (to_do, doing, done), the advisory Doing WIP limit and whole-Workspace counts per type. Needs a whole-Workspace credential and current Owner/Member access; reading never creates records. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  list_board_items: {
    title: "List Board work items",
    description:
      "List Epics, Features and PBIs of a Software Engineering Workspace Board, ordered by priority then number, with filters and cursor pagination. `total` and `counts` describe the whole filtered set, not just this page; follow `nextCursor` to read everything. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  read_board_item: {
    title: "Read a Board work item",
    description:
      "Read one work item with its description, PBI acceptance criteria and Implementation Prompt, linked specification chips (re-authorized on every read), newest notes and its `version`. Use the version as `expectedVersion` for changes. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  list_board_item_notes: {
    title: "List work-item notes",
    description:
      "List the delivery notes and evidence of a work item, newest first, with cursor pagination. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  create_board_item: {
    title: "Create a Board work item",
    description:
      "Create an Epic, a Feature (parent: an active Epic) or a PBI (parent: an active Feature) in the Workspace Board; it starts in to_do. Requires write access and an `idempotencyKey`: reuse the same key when retrying an uncertain create so it is applied exactly once. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  update_board_item: {
    title: "Update a Board work item",
    description:
      "Change fields, state or parent of a work item. Send `expectedVersion` from your last read; a STALE_VERSION error means someone else changed it — re-read and reconcile instead of overwriting. Parent and child states never change each other. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  link_board_specification: {
    title: "Link a specification to a work item",
    description:
      "Link an existing specification of this Workspace or of a Product currently in it, by its canonical id, so it shows on the card. Linking an already linked specification is a no-op. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  unlink_board_specification: {
    title: "Unlink a specification from a work item",
    description:
      "Remove only the link between a work item and a specification; the specification itself is untouched. Unlinking an absent link is a no-op. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  append_board_item_note: {
    title: "Append a work-item note",
    description:
      "Append delivery notes or validation evidence to a work item without changing its version. Requires an `idempotencyKey`; reuse it when retrying. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  archive_board_item: {
    title: "Archive a work item",
    description:
      "Archive a work item (Workspace Owner only). Items with active children cannot be archived; archive or move the children first. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  restore_board_item: {
    title: "Restore a work item",
    description:
      "Restore an archived work item (Workspace Owner only). Its parent must be active. Completing or linking work items never changes or approves specifications.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

const BOARD_TOOLS = Object.keys(CONTRACT);

// The contract's zod shapes, registered on a reference server so the
// comparison is against the SDK's own JSON Schema rendering of them.
async function contractSchemas(): Promise<Record<string, any>> {
  const ws = z.string().min(1).max(64).optional();
  const type = z.enum(["epic", "feature", "pbi"]);
  const state = z.enum(["to_do", "doing", "done"]);
  const priority = z.number().int().min(1).max(4);
  const key = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/);
  const version = z.number().int().min(1);
  const limit = z.number().int().min(1).max(100);
  const cursor = z.string().max(512);
  const tags = z.array(z.string().max(40)).max(20);
  const shapes: Record<string, z.ZodRawShape> = {
    read_board: { workspaceId: ws },
    list_board_items: {
      workspaceId: ws,
      type: type.optional(),
      state: state.optional(),
      parentId: z.string().optional(),
      productId: z.string().optional(),
      assigneeId: z.string().optional(),
      priority: priority.optional(),
      tag: z.string().max(40).optional(),
      query: z.string().max(200).optional(),
      archived: z.boolean().optional(),
      limit: limit.optional(),
      cursor: cursor.optional(),
    },
    read_board_item: { workspaceId: ws, itemId: z.string() },
    list_board_item_notes: {
      workspaceId: ws,
      itemId: z.string(),
      limit: limit.optional(),
      cursor: cursor.optional(),
    },
    create_board_item: {
      workspaceId: ws,
      type,
      parentId: z.string().optional(),
      title: z.string().min(1).max(256),
      description: z.string().max(20000).optional(),
      priority: priority.optional(),
      tags: tags.optional(),
      assigneeId: z.string().optional(),
      productId: z.string().optional(),
      acceptanceCriteria: z.string().max(20000).optional(),
      implementationPrompt: z.string().max(40000).optional(),
      idempotencyKey: key,
    },
    update_board_item: {
      workspaceId: ws,
      itemId: z.string(),
      expectedVersion: version,
      title: z.string().min(1).max(256).optional(),
      description: z.string().max(20000).optional(),
      priority: priority.optional(),
      tags: tags.optional(),
      assigneeId: z.string().nullable().optional(),
      productId: z.string().nullable().optional(),
      acceptanceCriteria: z.string().max(20000).optional(),
      implementationPrompt: z.string().max(40000).optional(),
      state: state.optional(),
      parentId: z.string().optional(),
    },
    link_board_specification: {
      workspaceId: ws,
      itemId: z.string(),
      specificationId: z.string(),
      expectedVersion: version,
    },
    unlink_board_specification: {
      workspaceId: ws,
      itemId: z.string(),
      specificationId: z.string(),
      expectedVersion: version,
    },
    append_board_item_note: {
      workspaceId: ws,
      itemId: z.string(),
      body: z.string().min(1).max(20000),
      idempotencyKey: key,
    },
    archive_board_item: { workspaceId: ws, itemId: z.string(), expectedVersion: version },
    restore_board_item: { workspaceId: ws, itemId: z.string(), expectedVersion: version },
  };
  const reference = new McpServer({ name: "contract", version: "0" }, { capabilities: { tools: {} } });
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

// ──────────────────────────────────────────────────────────────────────────
// API fixtures (DTOs of API › features/workspace-board.md §9.5)
// ──────────────────────────────────────────────────────────────────────────

const BOARD = {
  workspaceId: "ws_1",
  workspaceName: "Delivery",
  workspaceType: "software_engineering",
  archived: false,
  role: "OWNER",
  capabilities: { canWrite: true, canArchive: true },
  types: ["epic", "feature", "pbi"],
  states: ["to_do", "doing", "done"],
  wipLimit: 5,
  counts: {
    epic: { to_do: 1, doing: 0, done: 0, total: 1, archived: 0 },
    feature: { to_do: 1, doing: 0, done: 0, total: 1, archived: 0 },
    pbi: { to_do: 0, doing: 1, done: 0, total: 1, archived: 0 },
  },
  limits: { title: 256, description: 20000, implementationPrompt: 40000, tags: 20, links: 50 },
};

const ITEM = {
  id: "bi_3",
  workspaceId: "ws_1",
  displayNumber: 3,
  type: "pbi",
  parentId: "bi_2",
  parent: { id: "bi_2", displayNumber: 2, type: "feature", title: "Board tools", state: "to_do", archived: false },
  state: "doing",
  title: "Standalone Board tools",
  priority: 1,
  tags: ["mcp"],
  // A departed assignee and Product, and a deleted / moved-away spec: the
  // API redacts them; the package must pass the redaction through as is.
  assignee: { available: false },
  product: { available: false },
  childCounts: null,
  specifications: [
    {
      specificationId: "s_ws",
      available: true,
      title: "Board ADR",
      path: "adrs/board.md",
      status: "REVIEWED",
      scope: { type: "workspace", id: "ws_1", name: "Delivery" },
      route: "/workspace/ws_1/spec/s_ws",
    },
    { specificationId: "s_gone", available: false },
  ],
  version: 4,
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: "2026-10-01T12:05:00Z",
  description: "Package tools",
  acceptanceCriteria: "- tools discoverable",
  implementationPrompt: "Implement the standalone tools.",
  createdBy: { id: "u_1", name: "Owner" },
  notes: [{ id: "n_1", itemId: "bi_3", body: "Evidence", author: { id: "u_1", name: "Owner" }, createdAt: "2026-10-01T12:04:00Z" }],
  notesTotal: 1,
};

const ITEM_PAGE = {
  items: [{ ...ITEM, description: undefined }],
  total: 1,
  counts: { to_do: 0, doing: 1, done: 0 },
  limit: 50,
  nextCursor: "c_2",
};

const NOTES_PAGE = { notes: ITEM.notes, total: 1, limit: 20, nextCursor: null };

const NOTE_RESULT = { note: ITEM.notes[0], replayed: false };

function apiError(status: number, envelope: string, message: string, details?: Record<string, unknown>) {
  return { status, json: { error: { code: envelope, message, ...(details ? { details } : {}) } } };
}

// ──────────────────────────────────────────────────────────────────────────
// Harness
// ──────────────────────────────────────────────────────────────────────────

interface SentRequest {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; json?: unknown; raw?: string };

/** A recording fetch stub; `reply` decides each response from the request. */
function recorder(reply: (req: SentRequest) => Reply) {
  const sent: SentRequest[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const req: SentRequest = {
      method: init?.method ?? "GET",
      url: url.href,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(req);
    const r = reply(req);
    return new Response(r.raw ?? JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": r.raw ? "text/html" : "application/json" },
    });
  });
  return { sent, fetcher: fetcher as unknown as typeof fetch };
}

/** Success replies by route, as the API sends them. */
function boardApi(req: SentRequest): Reply {
  const m = req.path.match(/^\/api\/mcp\/workspaces\/([^/]+)\/board(.*)$/);
  if (!m) return { status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } };
  const rest = m[2];
  if (req.method === "GET" && rest === "") return { status: 200, json: { ...BOARD, workspaceId: decodeURIComponent(m[1]) } };
  if (req.method === "GET" && rest === "/items") return { status: 200, json: ITEM_PAGE };
  if (req.method === "POST" && rest === "/items") return { status: 201, json: { item: { ...ITEM, version: 1, state: "to_do" }, replayed: false } };
  if (req.method === "GET" && /^\/items\/[^/]+$/.test(rest)) return { status: 200, json: ITEM };
  if (req.method === "PATCH" && /^\/items\/[^/]+$/.test(rest)) return { status: 200, json: { ...ITEM, version: 5 } };
  if (req.method === "GET" && /^\/items\/[^/]+\/notes$/.test(rest)) return { status: 200, json: NOTES_PAGE };
  if (req.method === "POST" && /^\/items\/[^/]+\/notes$/.test(rest)) return { status: 201, json: NOTE_RESULT };
  if (req.method === "POST" && /^\/items\/[^/]+\/specifications$/.test(rest)) return { status: 200, json: { ...ITEM, version: 5 } };
  if (req.method === "DELETE" && /^\/items\/[^/]+\/specifications\/[^/]+$/.test(rest)) return { status: 200, json: { ...ITEM, version: 5 } };
  if (req.method === "POST" && /^\/items\/[^/]+\/archive$/.test(rest)) return { status: 200, json: { ...ITEM, version: 5, archivedAt: "2026-10-01T13:00:00Z" } };
  if (req.method === "POST" && /^\/items\/[^/]+\/restore$/.test(rest)) return { status: 200, json: { ...ITEM, version: 6 } };
  return { status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } };
}

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

const WORKSPACE_ONLY = makeConfig({ workspaceId: "ws_1", workspaceSource: "config-file", bindingMode: "workspace" });
const WORKSPACE_AND_PRODUCT = makeConfig({
  workspaceId: "ws_1",
  workspaceSource: "config-file",
  productId: "p_1",
  productSource: "config-file",
  bindingMode: "workspace+product",
});
const PRODUCT_ONLY = makeConfig({ productId: "p_1", productSource: "config-file", bindingMode: "product" });

async function connect(fetcher: typeof fetch, config: ResolvedConfig = WORKSPACE_ONLY) {
  const client = new KstonebaseClient({ apiUrl: config.apiUrl, token: TOKEN, fetcher });
  const server = buildServer({ config, client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "board-tools-test", version: "0.0.0" });
  await mcp.connect(clientSide);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  return {
    isError: res.isError === true,
    data: (res.structuredContent ?? {}) as Record<string, any>,
    text: content[0]?.text ?? "",
  };
}

async function ok(mcp: Client, name: string, args: Record<string, unknown>) {
  const out = await call(mcp, name, args);
  if (out.isError) throw new Error(`${name} failed: ${out.text}`);
  expect(JSON.parse(out.text)).toEqual(out.data);
  return out.data;
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

/** Minimal valid arguments for every tool (Workspace from the binding). */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  read_board: {},
  list_board_items: {},
  read_board_item: { itemId: "bi_3" },
  list_board_item_notes: { itemId: "bi_3" },
  create_board_item: { type: "epic", title: "Epic", idempotencyKey: "create-key-0001" },
  update_board_item: { itemId: "bi_3", expectedVersion: 4, state: "done" },
  link_board_specification: { itemId: "bi_3", specificationId: "s_ws", expectedVersion: 4 },
  unlink_board_specification: { itemId: "bi_3", specificationId: "s_ws", expectedVersion: 4 },
  append_board_item_note: { itemId: "bi_3", body: "Evidence", idempotencyKey: "note-key-0001" },
  archive_board_item: { itemId: "bi_3", expectedVersion: 4 },
  restore_board_item: { itemId: "bi_3", expectedVersion: 4 },
};

// ──────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────

describe("Board tools — discovery", () => {
  it("advertises the 11 tools with the contract's titles, descriptions, annotations and schemas", async () => {
    const { fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const { tools } = await mcp.listTools();
    const reference = await contractSchemas();
    expect(BOARD_TOOLS).toHaveLength(11);
    for (const name of BOARD_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.title, name).toBe(CONTRACT[name].title);
      expect(tool!.description, name).toBe(CONTRACT[name].description);
      expect(tool!.annotations, name).toEqual(CONTRACT[name].annotations);
      expect(tool!.inputSchema, name).toEqual(reference[name]);
    }
    await close();
  });

  it("states the no-approval rule and never mentions an external board", async () => {
    const { fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const { tools } = await mcp.listTools();
    for (const name of BOARD_TOOLS) {
      const description = tools.find((t) => t.name === name)!.description!;
      expect(description.endsWith(` ${SPEC_SENTENCE}`), name).toBe(true);
      expect(description).not.toMatch(/azure|jira|devops|codex|claude|chatgpt|openai/i);
    }
    await close();
  });

  it("renders the bounds, enums, nullability and required keys the agent sees", async () => {
    const { fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const { tools } = await mcp.listTools();
    const schema = (name: string) =>
      tools.find((t) => t.name === name)!.inputSchema as { properties: Record<string, any>; required?: string[] };

    for (const name of BOARD_TOOLS) {
      expect(schema(name).properties.workspaceId, name).toEqual({ type: "string", minLength: 1, maxLength: 64 });
      expect(schema(name).required ?? [], name).not.toContain("workspaceId");
    }
    expect(schema("read_board").required).toBeUndefined();
    expect(schema("list_board_items").required).toBeUndefined();
    expect(schema("read_board_item").required).toEqual(["itemId"]);
    expect(schema("list_board_item_notes").required).toEqual(["itemId"]);
    expect(schema("create_board_item").required).toEqual(["type", "title", "idempotencyKey"]);
    expect(schema("update_board_item").required).toEqual(["itemId", "expectedVersion"]);
    expect(schema("link_board_specification").required).toEqual(["itemId", "specificationId", "expectedVersion"]);
    expect(schema("unlink_board_specification").required).toEqual(["itemId", "specificationId", "expectedVersion"]);
    expect(schema("append_board_item_note").required).toEqual(["itemId", "body", "idempotencyKey"]);
    expect(schema("archive_board_item").required).toEqual(["itemId", "expectedVersion"]);
    expect(schema("restore_board_item").required).toEqual(["itemId", "expectedVersion"]);

    const create = schema("create_board_item").properties;
    expect(create.type.enum).toEqual(["epic", "feature", "pbi"]);
    expect(create.title).toEqual({ type: "string", minLength: 1, maxLength: 256 });
    expect(create.description.maxLength).toBe(20000);
    expect(create.acceptanceCriteria.maxLength).toBe(20000);
    expect(create.implementationPrompt.maxLength).toBe(40000);
    expect(create.tags).toEqual({ type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20 });
    expect(create.priority).toEqual({ type: "integer", minimum: 1, maximum: 4 });
    expect(create.idempotencyKey).toEqual({ type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" });
    expect(create).not.toHaveProperty("state");
    expect(schema("append_board_item_note").properties.idempotencyKey).toEqual(create.idempotencyKey);
    expect(schema("append_board_item_note").properties.body).toEqual({ type: "string", minLength: 1, maxLength: 20000 });

    const update = schema("update_board_item").properties;
    expect(update.expectedVersion).toEqual({ type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
    expect(update.assigneeId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(update.productId).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(update.state.enum).toEqual(["to_do", "doing", "done"]);
    expect(update).not.toHaveProperty("type");
    expect(update).not.toHaveProperty("idempotencyKey");

    const list = schema("list_board_items").properties;
    expect(list.limit).toEqual({ type: "integer", minimum: 1, maximum: 100 });
    expect(list.cursor).toEqual({ type: "string", maxLength: 512 });
    expect(list.query).toEqual({ type: "string", maxLength: 200 });
    expect(list.tag).toEqual({ type: "string", maxLength: 40 });
    expect(list.archived).toEqual({ type: "boolean" });
    await close();
  });

  it("declares every Board tool in the ChatGPT app manifest with the same annotations", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8"),
    ) as { tools: Record<string, { annotations: Record<string, boolean>; justifications: Record<string, string> }> };
    for (const name of BOARD_TOOLS) {
      expect(manifest.tools, name).toHaveProperty(name);
      expect(manifest.tools[name].annotations, name).toEqual(CONTRACT[name].annotations);
      expect(Object.keys(manifest.tools[name].justifications).sort(), name).toEqual([
        "destructive_justification",
        "open_world_justification",
        "read_only_justification",
      ]);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Request forwarding and result passthrough
// ──────────────────────────────────────────────────────────────────────────

describe("Board tools — forwarding", () => {
  it("read_board → GET …/board, Bearer only, Board passed through unchanged", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    expect(await ok(mcp, "read_board", {})).toEqual(BOARD);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: "GET", url: `${API_URL}/api/mcp/workspaces/ws_1/board`, body: undefined });
    expect(sent[0].headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
    await close();
  });

  it("list_board_items → every filter in the query string (query → q, archived kept when false)", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    expect(await ok(mcp, "list_board_items", {})).toEqual(JSON.parse(JSON.stringify(ITEM_PAGE)));
    await ok(mcp, "list_board_items", {
      type: "pbi",
      state: "doing",
      parentId: "bi_2",
      productId: "none",
      assigneeId: "none",
      priority: 2,
      tag: "MCP",
      query: "#12",
      archived: false,
      limit: 100,
      cursor: "c_2",
    });
    await ok(mcp, "list_board_items", { archived: true, productId: "p 1" });
    expect(sent[0].url).toBe(`${API_URL}/api/mcp/workspaces/ws_1/board/items`);
    expect(sent[1].query).toEqual({
      type: "pbi",
      state: "doing",
      parentId: "bi_2",
      productId: "none",
      assigneeId: "none",
      priority: "2",
      tag: "MCP",
      q: "#12",
      archived: "false",
      limit: "100",
      cursor: "c_2",
    });
    expect(sent[2].query).toEqual({ archived: "true", productId: "p 1" });
    await close();
  });

  it("read_board_item and list_board_item_notes → GET on the encoded item paths", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    expect(await ok(mcp, "read_board_item", { itemId: "bi/3?x" })).toEqual(ITEM);
    expect(await ok(mcp, "list_board_item_notes", { itemId: "bi_3", limit: 5, cursor: "n:2" })).toEqual(NOTES_PAGE);
    await ok(mcp, "list_board_item_notes", { itemId: "bi_3" });
    expect(sent.map((r) => [r.method, r.url])).toEqual([
      ["GET", `${API_URL}/api/mcp/workspaces/ws_1/board/items/bi%2F3%3Fx`],
      ["GET", `${API_URL}/api/mcp/workspaces/ws_1/board/items/bi_3/notes?limit=5&cursor=n%3A2`],
      ["GET", `${API_URL}/api/mcp/workspaces/ws_1/board/items/bi_3/notes`],
    ]);
    await close();
  });

  it("create_board_item → POST with only the given keys; the idempotencyKey is sent exactly as given", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const created = await ok(mcp, "create_board_item", { type: "epic", title: "Board", idempotencyKey: "Epic.board:2026-10-01_A" });
    expect(created).toEqual({ item: { ...ITEM, version: 1, state: "to_do" }, replayed: false });
    await ok(mcp, "create_board_item", {
      type: "pbi",
      parentId: "bi_2",
      title: "Standalone Board tools",
      description: "d",
      priority: 1,
      tags: ["mcp", "board"],
      assigneeId: "u_2",
      productId: "p_1",
      acceptanceCriteria: "- ac",
      implementationPrompt: "prompt",
      idempotencyKey: "pbi-410-create",
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${API_URL}/api/mcp/workspaces/ws_1/board/items`,
      body: { type: "epic", title: "Board", idempotencyKey: "Epic.board:2026-10-01_A" },
    });
    expect(sent[0].headers["content-type"]).toBe("application/json");
    expect(sent[1].body).toEqual({
      type: "pbi",
      parentId: "bi_2",
      title: "Standalone Board tools",
      description: "d",
      priority: 1,
      tags: ["mcp", "board"],
      assigneeId: "u_2",
      productId: "p_1",
      acceptanceCriteria: "- ac",
      implementationPrompt: "prompt",
      idempotencyKey: "pbi-410-create",
    });
    await close();
  });

  it("update_board_item → PATCH with only the provided fields; null clears assignee/Product; unknown keys never reach the API", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    await ok(mcp, "update_board_item", { itemId: "bi_3", expectedVersion: 4, state: "doing" });
    await ok(mcp, "update_board_item", { itemId: "bi_3", expectedVersion: 5, assigneeId: null, productId: null });
    await ok(mcp, "update_board_item", {
      itemId: "bi_3",
      expectedVersion: 6,
      title: "t",
      description: "",
      priority: 3,
      tags: [],
      assigneeId: "u_2",
      productId: "p_1",
      acceptanceCriteria: "ac",
      implementationPrompt: "ip",
      state: "done",
      parentId: "bi_9",
    });
    await ok(mcp, "update_board_item", { itemId: "bi_3", expectedVersion: 7, version: 99, approvedVersion: 2, status: "REVIEWED" });
    expect(sent.map((r) => r.method)).toEqual(["PATCH", "PATCH", "PATCH", "PATCH"]);
    expect(sent[0].url).toBe(`${API_URL}/api/mcp/workspaces/ws_1/board/items/bi_3`);
    expect(sent[0].body).toEqual({ expectedVersion: 4, state: "doing" });
    expect(sent[1].body).toEqual({ expectedVersion: 5, assigneeId: null, productId: null });
    expect(sent[2].body).toEqual({
      expectedVersion: 6,
      title: "t",
      description: "",
      priority: 3,
      tags: [],
      assigneeId: "u_2",
      productId: "p_1",
      acceptanceCriteria: "ac",
      implementationPrompt: "ip",
      state: "done",
      parentId: "bi_9",
    });
    // No specification lifecycle field can be smuggled through.
    expect(sent[3].body).toEqual({ expectedVersion: 7 });
    await close();
  });

  it("link → POST {expectedVersion, specificationId}; unlink → DELETE with a JSON {expectedVersion} body", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    await ok(mcp, "link_board_specification", { itemId: "bi_3", specificationId: "cmp3ca82e2283c47e6e6fffb", expectedVersion: 4 });
    await ok(mcp, "unlink_board_specification", { itemId: "bi_3", specificationId: "spec/../x", expectedVersion: 5 });
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${API_URL}/api/mcp/workspaces/ws_1/board/items/bi_3/specifications`,
      body: { expectedVersion: 4, specificationId: "cmp3ca82e2283c47e6e6fffb" },
    });
    expect(sent[1]).toMatchObject({
      method: "DELETE",
      url: `${API_URL}/api/mcp/workspaces/ws_1/board/items/bi_3/specifications/spec%2F..%2Fx`,
      body: { expectedVersion: 5 },
    });
    expect(sent[1].headers["content-type"]).toBe("application/json");
    await close();
  });

  it("append note → POST {body, idempotencyKey}; archive/restore → POST {expectedVersion}", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    expect(await ok(mcp, "append_board_item_note", { itemId: "bi_3", body: "Validated: 172 tests", idempotencyKey: "note-410-1" })).toEqual(NOTE_RESULT);
    await ok(mcp, "archive_board_item", { itemId: "bi_3", expectedVersion: 4 });
    await ok(mcp, "restore_board_item", { itemId: "bi_3", expectedVersion: 5 });
    expect(sent.map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/api/mcp/workspaces/ws_1/board/items/bi_3/notes", { body: "Validated: 172 tests", idempotencyKey: "note-410-1" }],
      ["POST", "/api/mcp/workspaces/ws_1/board/items/bi_3/archive", { expectedVersion: 4 }],
      ["POST", "/api/mcp/workspaces/ws_1/board/items/bi_3/restore", { expectedVersion: 5 }],
    ]);
    await close();
  });

  it("only ever calls the Board routes: no specification route is touched by any Board tool", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    for (const name of BOARD_TOOLS) await ok(mcp, name, MINIMAL_ARGS[name]);
    expect(sent).toHaveLength(BOARD_TOOLS.length);
    for (const req of sent) expect(req.path.startsWith("/api/mcp/workspaces/ws_1/board")).toBe(true);
    await close();
  });

  it("rejects out-of-contract arguments before calling the API", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const bad: Array<[string, Record<string, unknown>]> = [
      ["create_board_item", { type: "epic", title: "x" }],
      ["create_board_item", { type: "epic", title: "x", idempotencyKey: "short" }],
      ["create_board_item", { type: "epic", title: "x", idempotencyKey: "has space key" }],
      ["create_board_item", { type: "epic", title: "x", idempotencyKey: "k".repeat(129) }],
      ["create_board_item", { type: "story", title: "x", idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "epic", title: "", idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "epic", title: "t".repeat(257), idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "epic", title: "x", tags: Array.from({ length: 21 }, (_, i) => `t${i}`), idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "epic", title: "x", tags: ["t".repeat(41)], idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "pbi", title: "x", implementationPrompt: "p".repeat(40001), idempotencyKey: "valid-key-1" }],
      ["create_board_item", { type: "epic", title: "x", priority: 5, idempotencyKey: "valid-key-1" }],
      ["update_board_item", { itemId: "bi_3", expectedVersion: 0, state: "done" }],
      ["update_board_item", { itemId: "bi_3", state: "done" }],
      ["update_board_item", { itemId: "bi_3", expectedVersion: 1, state: "blocked" }],
      ["append_board_item_note", { itemId: "bi_3", body: "", idempotencyKey: "valid-key-1" }],
      ["append_board_item_note", { itemId: "bi_3", body: "x" }],
      ["list_board_items", { limit: 101 }],
      ["list_board_items", { cursor: "c".repeat(513) }],
      ["list_board_items", { query: "q".repeat(201) }],
      ["list_board_items", { priority: 0 }],
      ["read_board", { workspaceId: "" }],
      ["read_board", { workspaceId: "w".repeat(65) }],
      ["archive_board_item", { itemId: "bi_3", expectedVersion: 1.5 }],
    ];
    for (const [name, args] of bad) {
      const out = await call(mcp, name, args);
      expect(out.isError, `${name} ${JSON.stringify(args).slice(0, 80)}`).toBe(true);
    }
    for (const [name, args] of [
      ["read_board_item", { itemId: "" }],
      ["read_board_item", { itemId: ".." }],
      ["unlink_board_specification", { itemId: "bi_3", specificationId: ".", expectedVersion: 1 }],
    ] as const) {
      const out = await call(mcp, name, args);
      expect(out.isError).toBe(true);
      expect(out.data.code).toBe("VALIDATION_ERROR");
    }
    expect(sent).toHaveLength(0);
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Workspace targeting (spec §2.1 and §3)
// ──────────────────────────────────────────────────────────────────────────

describe("Board tools — Workspace binding", () => {
  it("Workspace-only and Workspace+Product-default bindings both target only the Workspace", async () => {
    for (const config of [WORKSPACE_ONLY, WORKSPACE_AND_PRODUCT]) {
      const { sent, fetcher } = recorder(boardApi);
      const { mcp, close } = await connect(fetcher, config);
      for (const name of BOARD_TOOLS) await ok(mcp, name, MINIMAL_ARGS[name]);
      for (const req of sent) {
        expect(req.path.startsWith("/api/mcp/workspaces/ws_1/board"), req.path).toBe(true);
        // The binding's productId never becomes a filter or a field.
        expect(req.query).not.toHaveProperty("productId");
        expect(JSON.stringify(req.body ?? {})).not.toContain("p_1");
      }
      await close();
    }
  });

  it("a Product-only binding fails with WORKSPACE_NOT_BOUND before any request, for every Board tool", async () => {
    for (const config of [PRODUCT_ONLY, makeConfig()]) {
      const { sent, fetcher } = recorder(boardApi);
      const { mcp, close } = await connect(fetcher, config);
      for (const name of BOARD_TOOLS) {
        const out = await call(mcp, name, MINIMAL_ARGS[name]);
        expect(out.isError, name).toBe(true);
        expect(out.data.code, name).toBe("WORKSPACE_NOT_BOUND");
        expect(out.data.message).toContain("A productId binding never selects a Board");
        expect(out.data.remediation).toContain("workspaceId");
      }
      expect(sent).toHaveLength(0);
      await close();
    }
  });

  it("an explicit workspaceId works without a Workspace binding and wins over the binding", async () => {
    const { sent, fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher, PRODUCT_ONLY);
    expect((await ok(mcp, "read_board", { workspaceId: "ws_9" })).workspaceId).toBe("ws_9");
    await close();
    const second = await connect(fetcher, WORKSPACE_AND_PRODUCT);
    await ok(second.mcp, "create_board_item", { workspaceId: "ws 2", type: "epic", title: "E", idempotencyKey: "explicit-ws-1" });
    await second.close();
    expect(sent.map((r) => r.path)).toEqual([
      "/api/mcp/workspaces/ws_9/board",
      "/api/mcp/workspaces/ws%202/board/items",
    ]);
  });

  it("a Product-restricted credential gets WORKSPACE_SCOPE_REQUIRED with the API hint (the binding does not broaden it)", async () => {
    const hint =
      "Board tools need a whole-Workspace credential. Re-bind this credential to the Workspace (or all Workspaces) in Kstonebase settings; a Product-restricted credential never reaches the Workspace Board.";
    const { sent, fetcher } = recorder(() =>
      apiError(403, "FORBIDDEN", "WORKSPACE_SCOPE_REQUIRED", { code: "WORKSPACE_SCOPE_REQUIRED", hint }),
    );
    const { mcp, close } = await connect(fetcher, WORKSPACE_AND_PRODUCT);
    for (const name of ["read_board", "list_board_items", "create_board_item"]) {
      const out = await call(mcp, name, name === "list_board_items" ? { productId: "p_1" } : MINIMAL_ARGS[name]);
      expect(out.isError).toBe(true);
      expect(out.data).toEqual({
        code: "WORKSPACE_SCOPE_REQUIRED",
        message: "WORKSPACE_SCOPE_REQUIRED",
        remediation: expect.stringContaining("whole-Workspace credential"),
        details: { hint },
      });
      expect(out.data.remediation).toContain("never widens");
      expect(out.text).toContain(hint);
    }
    // One request per call: nothing retried, nothing re-targeted.
    expect(sent.map((r) => r.path)).toEqual([
      "/api/mcp/workspaces/ws_1/board",
      "/api/mcp/workspaces/ws_1/board/items",
      "/api/mcp/workspaces/ws_1/board/items",
    ]);
    await close();
  });

  it("a read-only credential's write is TOKEN_SCOPE_INSUFFICIENT; a credential pinned elsewhere is TOKEN_SCOPE_MISMATCH", async () => {
    const replies: Reply[] = [
      apiError(403, "FORBIDDEN", "TOKEN_SCOPE_INSUFFICIENT", { code: "TOKEN_SCOPE_INSUFFICIENT" }),
      apiError(403, "FORBIDDEN", "TOKEN_SCOPE_MISMATCH", { code: "TOKEN_SCOPE_MISMATCH" }),
    ];
    const { fetcher } = recorder(() => replies.shift()!);
    const { mcp, close } = await connect(fetcher);
    const insufficient = await call(mcp, "create_board_item", MINIMAL_ARGS.create_board_item);
    expect(insufficient.data.code).toBe("TOKEN_SCOPE_INSUFFICIENT");
    expect(insufficient.data.remediation).toContain("`write` scope");
    const mismatch = await call(mcp, "read_board", { workspaceId: "ws_other" });
    expect(mismatch.data.code).toBe("TOKEN_SCOPE_MISMATCH");
    expect(mismatch.data.remediation).toContain("pinned to another Workspace");
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Retries, conflicts and redaction
// ──────────────────────────────────────────────────────────────────────────

describe("Board tools — retries and conflicts", () => {
  it("a retried create forwards the same idempotencyKey and passes replayed:true through", async () => {
    let n = 0;
    const { sent, fetcher } = recorder((req) => {
      n += 1;
      return { status: 201, json: { item: { ...ITEM, version: 1, state: "to_do" }, replayed: n > 1 } };
    });
    const { mcp, close } = await connect(fetcher);
    const args = { type: "pbi", parentId: "bi_2", title: "Retry me", idempotencyKey: "uncertain-create-7" };
    expect((await ok(mcp, "create_board_item", args)).replayed).toBe(false);
    const again = await ok(mcp, "create_board_item", args);
    expect(again.replayed).toBe(true);
    expect(again.item.id).toBe(ITEM.id);
    expect(sent).toHaveLength(2);
    expect(sent[0].body).toEqual(sent[1].body);
    expect((sent[1].body as Record<string, unknown>).idempotencyKey).toBe("uncertain-create-7");
    await close();
  });

  it("a create that fails in flight is not retried and tells the agent to retry with the same key", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const { mcp, close } = await connect(fetcher as unknown as typeof fetch);
    for (const [name, args] of [
      ["create_board_item", MINIMAL_ARGS.create_board_item],
      ["append_board_item_note", MINIMAL_ARGS.append_board_item_note],
    ] as const) {
      const out = await call(mcp, name, args);
      expect(out.isError).toBe(true);
      expect(out.data.code).toBe("INTERNAL_ERROR");
      expect(out.data.message).toContain("fetch failed");
      expect(out.data.remediation).toContain("only with the same idempotencyKey, never a new one");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    const keys = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).idempotencyKey);
    expect(keys).toEqual(["create-key-0001", "note-key-0001"]);
    await close();
  });

  it("IDEMPOTENCY_KEY_REUSED surfaces as is", async () => {
    const { fetcher } = recorder(() => apiError(409, "CONFLICT", "That key was used for another request.", { code: "IDEMPOTENCY_KEY_REUSED" }));
    const { mcp, close } = await connect(fetcher);
    const out = await call(mcp, "create_board_item", MINIMAL_ARGS.create_board_item);
    expect(out.data.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(out.data.remediation).toContain("new key");
    await close();
  });

  it("STALE_VERSION carries currentVersion, drops the current item and says re-read, never replay", async () => {
    const { sent, fetcher } = recorder(() =>
      apiError(409, "CONFLICT", "The work item changed since you read it.", {
        code: "STALE_VERSION",
        currentVersion: 7,
        item: { ...ITEM, version: 7 },
      }),
    );
    const { mcp, close } = await connect(fetcher);
    for (const name of ["update_board_item", "link_board_specification", "unlink_board_specification", "archive_board_item", "restore_board_item"]) {
      const out = await call(mcp, name, MINIMAL_ARGS[name]);
      expect(out.isError).toBe(true);
      expect(out.data).toEqual({
        code: "STALE_VERSION",
        message: "The work item changed since you read it.",
        remediation: expect.stringContaining("read_board_item"),
        details: { currentVersion: 7 },
      });
      expect(out.data.remediation).toContain("Never replay the old request blindly");
      expect(out.text).toContain('"currentVersion":7');
      expect(out.text).not.toContain("implementationPrompt");
    }
    expect(sent).toHaveLength(5);
    await close();
  });

  it("passes redacted Product, assignee and specification references through unchanged", async () => {
    const { fetcher } = recorder(boardApi);
    const { mcp, close } = await connect(fetcher);
    const item = await ok(mcp, "read_board_item", { itemId: "bi_3" });
    expect(item.assignee).toEqual({ available: false });
    expect(item.product).toEqual({ available: false });
    expect(item.specifications[1]).toEqual({ specificationId: "s_gone", available: false });
    expect(item).toEqual(ITEM);
    await close();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Error mapping for every Board code (API § 9.3)
// ──────────────────────────────────────────────────────────────────────────

describe("Board tools — error mapping", () => {
  const cases: Array<{ tool: string; status: number; envelope: string; details: Record<string, unknown>; expected?: Record<string, unknown> }> = [
    { tool: "read_board", status: 404, envelope: "NOT_FOUND", details: { code: "NOT_FOUND" } },
    { tool: "read_board", status: 404, envelope: "NOT_FOUND", details: { code: "BOARD_UNAVAILABLE" } },
    { tool: "read_board_item", status: 404, envelope: "NOT_FOUND", details: { code: "ITEM_NOT_FOUND" } },
    { tool: "create_board_item", status: 409, envelope: "CONFLICT", details: { code: "WORKSPACE_ARCHIVED" } },
    { tool: "archive_board_item", status: 403, envelope: "FORBIDDEN", details: { code: "OWNER_REQUIRED" } },
    { tool: "create_board_item", status: 400, envelope: "BAD_REQUEST", details: { code: "VALIDATION_ERROR", field: "title", problem: "too-long" }, expected: { field: "title", problem: "too-long" } },
    { tool: "create_board_item", status: 400, envelope: "BAD_REQUEST", details: { code: "INVALID_PARENT", field: "parentId", problem: "wrong-type" }, expected: { field: "parentId", problem: "wrong-type" } },
    { tool: "update_board_item", status: 400, envelope: "BAD_REQUEST", details: { code: "INVALID_ASSIGNEE", field: "assigneeId" }, expected: { field: "assigneeId" } },
    { tool: "update_board_item", status: 400, envelope: "BAD_REQUEST", details: { code: "INVALID_PRODUCT", field: "productId" }, expected: { field: "productId" } },
    { tool: "list_board_items", status: 400, envelope: "BAD_REQUEST", details: { code: "INVALID_CURSOR", field: "cursor" }, expected: { field: "cursor" } },
    { tool: "append_board_item_note", status: 409, envelope: "CONFLICT", details: { code: "IDEMPOTENCY_KEY_REUSED" } },
    { tool: "archive_board_item", status: 409, envelope: "CONFLICT", details: { code: "ACTIVE_CHILDREN", activeChildren: 3 }, expected: { activeChildren: 3 } },
    { tool: "restore_board_item", status: 409, envelope: "CONFLICT", details: { code: "PARENT_ARCHIVED" } },
    { tool: "append_board_item_note", status: 409, envelope: "CONFLICT", details: { code: "ITEM_ARCHIVED" } },
    { tool: "restore_board_item", status: 409, envelope: "CONFLICT", details: { code: "ITEM_NOT_ARCHIVED" } },
    { tool: "link_board_specification", status: 404, envelope: "NOT_FOUND", details: { code: "SPECIFICATION_UNAVAILABLE", field: "specificationId" }, expected: { field: "specificationId" } },
    { tool: "link_board_specification", status: 409, envelope: "CONFLICT", details: { code: "SPECIFICATION_ARCHIVED", field: "specificationId" }, expected: { field: "specificationId" } },
    { tool: "link_board_specification", status: 409, envelope: "CONFLICT", details: { code: "LINK_LIMIT_REACHED", limit: 50 }, expected: { limit: 50 } },
    { tool: "update_board_item", status: 409, envelope: "CONFLICT", details: { code: "STALE_VERSION", currentVersion: 9 }, expected: { currentVersion: 9 } },
    { tool: "read_board", status: 403, envelope: "FORBIDDEN", details: { code: "WORKSPACE_SCOPE_REQUIRED", hint: "h" }, expected: { hint: "h" } },
    { tool: "read_board", status: 403, envelope: "FORBIDDEN", details: { code: "TOKEN_SCOPE_MISMATCH" } },
    { tool: "update_board_item", status: 403, envelope: "FORBIDDEN", details: { code: "TOKEN_SCOPE_INSUFFICIENT" } },
  ];

  for (const c of cases) {
    it(`${c.tool}: ${c.envelope}/${String(c.details.code)} (HTTP ${c.status}) → ${String(c.details.code)}`, async () => {
      const { sent, fetcher } = recorder(() =>
        apiError(c.status, c.envelope, `translated ${String(c.details.code)}`, { ...c.details, internal: "dropped", item: { id: "x" } }),
      );
      const { mcp, close } = await connect(fetcher);
      const out = await call(mcp, c.tool, MINIMAL_ARGS[c.tool]);
      expect(out.isError).toBe(true);
      expect(out.data.code).toBe(c.details.code);
      expect(out.data.message).toBe(`translated ${String(c.details.code)}`);
      expect(typeof out.data.remediation).toBe("string");
      expect(out.data.remediation.length).toBeGreaterThan(30);
      if (c.expected) expect(out.data.details).toEqual(c.expected);
      else expect(out.data).not.toHaveProperty("details");
      expect(out.text.startsWith(`${String(c.details.code)}: translated`)).toBe(true);
      expect(sent).toHaveLength(1);
      await close();
    });
  }

  it("maps a REST-style 401 to AUTH_FAILED and a code-less 404 page to a missing-server-support explanation", async () => {
    const replies: Reply[] = [
      { status: 401, json: { result: false, message: "Unauthorized" } },
      { status: 404, raw: "<!doctype html><title>404</title>" },
      { status: 405, raw: "Method Not Allowed" },
    ];
    const { fetcher } = recorder(() => replies.shift()!);
    const { mcp, close } = await connect(fetcher);
    expect((await call(mcp, "read_board", {})).data.code).toBe("AUTH_FAILED");
    const missing = await call(mcp, "read_board", {});
    expect(missing.data.code).toBe("NOT_FOUND");
    expect(missing.data.remediation).toContain("does not serve the native Board tools");
    const notAllowed = await call(mcp, "unlink_board_specification", MINIMAL_ARGS.unlink_board_specification);
    expect(notAllowed.data.code).toBe("INTERNAL_ERROR");
    expect(notAllowed.data.remediation).toContain("does not serve the native Board tools");
    await close();
  });

  it("logs Board failures without the token, note bodies or prompts", async () => {
    const { fetcher } = recorder(() => apiError(409, "CONFLICT", "m", { code: "ITEM_ARCHIVED" }));
    const { mcp, close } = await connect(fetcher);
    await call(mcp, "append_board_item_note", { itemId: "bi_3", body: "SECRET-NOTE-BODY", idempotencyKey: "note-key-0002" });
    await call(mcp, "create_board_item", { type: "pbi", title: "t", implementationPrompt: "SECRET-PROMPT", idempotencyKey: "create-key-0002" });
    const logs = stderrLines.join("");
    expect(logs).toContain("append_board_item_note");
    expect(logs).not.toContain(TOKEN);
    expect(logs).not.toContain("SECRET-NOTE-BODY");
    expect(logs).not.toContain("SECRET-PROMPT");
    await close();
  });
});
