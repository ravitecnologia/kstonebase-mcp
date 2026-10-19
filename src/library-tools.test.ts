// Contract tests for the Workspace Library tools (Kstonebase MCP spec
// "features/mcp-library-tools.md" §1–§5, PBI 352; backed by API ›
// features/workspace-library.md §9 and the frozen Epic 340 wire contract
// §4–§5). The server is built exactly as both transports build it
// (buildServer) and driven by the SDK client over an in-memory transport,
// against a recording fake of the API's `/api/mcp/…` Library routes. These
// tests prove what the package owns — discovery, Workspace targeting,
// argument forwarding, result passthrough, secret refusals and error mapping —
// and that no code path ever fetches a returned link.

import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_LIBRARY_TOOL_TEST";
const API_URL = "https://api.kstonebase.test";

// ──────────────────────────────────────────────────────────────────────────
// Contract literals, kept independent of library-catalog.ts so any drift
// fails here.
// ──────────────────────────────────────────────────────────────────────────

const SCOPE =
  "Library tools need a credential that covers the whole Workspace; a Product-only token or binding gets not found.";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_OPEN_WORLD = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

const CONTRACT: Record<string, { title: string; description: string; annotations: Record<string, boolean> }> = {
  list_library: {
    title: "List the Workspace Library",
    description: `List the folders and media files (images, videos and audio) of a Workspace Library, one folder at a time (the root when folderId is omitted), with cursor pagination. Each file shows its id, name, kind, content type, size, exposure (common or secret), folder path and dates. workspaceId defaults to the bound Workspace. Listing never returns file contents or links. ${SCOPE}`,
    annotations: READ,
  },
  read_library_file: {
    title: "Read a Library file",
    description: `Read one Library file's metadata: name, kind, content type, size, exposure, folder path, uploader and dates. It never returns contents or links. For a common file use get_library_file_link or read_library_file_content; for a secret file use request_library_file_access. ${SCOPE}`,
    annotations: READ,
  },
  get_library_file_link: {
    title: "Get a Library file link",
    description: `Get a temporary HTTPS link (valid for at most 15 minutes) to a common Library file, to hand to another tool that needs the file, for example another MCP server's import-from-URL tool. The link is temporary: pass it immediately to the tool that needs it and never store it in specifications, notes or memory. A secret file answers approval required: call request_library_file_access instead. ${SCOPE}`,
    annotations: READ_OPEN_WORLD,
  },
  read_library_file_content: {
    title: "Read a Library file's content",
    description: `Return a common Library image or audio file of up to 10 MB as MCP image or audio content, so you can see or hear it. Videos and larger files are not returned: use get_library_file_link. Secret files are never returned: use request_library_file_access. ${SCOPE}`,
    annotations: READ_OPEN_WORLD,
  },
  request_library_file_access: {
    title: "Request access to a secret Library file",
    description: `Ask a person to approve access to a secret Library file. State the purpose (up to 500 characters); it is shown to the person who decides. Returns a pending request with its requestId, expiresAt (10 minutes) and approvalUrl. Then ask the user to approve it in Kstonebase with their password, and call read_library_file_access. Client settings that allow all actions never approve a request. A common file needs no approval: use get_library_file_link. ${SCOPE}`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  read_library_file_access: {
    title: "Read a Library access request",
    description:
      "Read the status of your access request for a secret Library file: pending, approved, rejected, expired or redeemed. Once approved it returns a one-time link that works once and expires 5 minutes after approval. Hand that link directly to the tool that needs the file; never fetch or open it through Kstonebase, and never store it. Only the credential that made the request can read it.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
};

const LIBRARY_TOOLS = Object.keys(CONTRACT);

/** Spec §3 messages (the code's message) by `details.code`. */
const MESSAGES = {
  LIBRARY_APPROVAL_REQUIRED:
    "This file is Secret. Call request_library_file_access with a purpose and ask the user to approve it in Kstonebase.",
  LIBRARY_CONTENT_TOO_LARGE:
    "This file is a video or larger than 10 MB, so it is not returned as content. Call get_library_file_link and pass the temporary link to the tool that needs the file.",
  LIBRARY_NOT_SECRET:
    "This file is Common and needs no approval. Call get_library_file_link or read_library_file_content instead.",
  LIBRARY_TOO_MANY_PENDING:
    "Too many access requests are waiting for a decision. Wait for the user to approve or reject them in Kstonebase before requesting again.",
  NOT_FOUND: "Not found or outside this credential's scope.",
} as const;

async function contractSchemas(): Promise<Record<string, any>> {
  const id = (d: string) => z.string().min(1).max(64).describe(d);
  const fileId = () => id("Library file id, from list_library.");
  const shapes: Record<string, z.ZodRawShape> = {
    list_library: {
      workspaceId: z.string().min(1).max(64).optional().describe("Workspace id. Defaults to the bound Workspace."),
      folderId: z.string().min(1).max(64).optional().describe("Folder to list. Omit for the Library root."),
      cursor: z.string().max(512).optional().describe("nextCursor from the previous page."),
      limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100, default 50)."),
    },
    read_library_file: { fileId: fileId() },
    get_library_file_link: { fileId: fileId() },
    read_library_file_content: { fileId: fileId() },
    request_library_file_access: {
      fileId: id("Secret Library file id, from list_library."),
      purpose: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "Why you need the file (up to 500 characters). It is shown to the person who approves or rejects the request.",
        ),
    },
    read_library_file_access: { requestId: id("requestId returned by request_library_file_access.") },
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
// API fixtures (frozen contract §4)
// ──────────────────────────────────────────────────────────────────────────

const FOLDER = {
  id: "fo_1",
  workspaceId: "ws_1",
  parentId: null,
  name: "Brand",
  path: "Brand",
  createdAt: "2026-10-19T01:00:00Z",
  updatedAt: "2026-10-19T01:00:00Z",
};

const IMAGE = {
  id: "f_img",
  workspaceId: "ws_1",
  folderId: null,
  folderPath: "",
  name: "profile.jpg",
  kind: "image",
  contentType: "image/jpeg",
  size: 123_456,
  exposure: "common",
  createdAt: "2026-10-19T01:00:00Z",
  updatedAt: "2026-10-19T01:00:00Z",
};

const AUDIO = { ...IMAGE, id: "f_aud", name: "voice.mp3", kind: "audio", contentType: "audio/mpeg", size: 9_999_999 };
const BIG_AUDIO = { ...AUDIO, id: "f_big", size: 10_000_001 };
const VIDEO = { ...IMAGE, id: "f_vid", name: "intro.mp4", kind: "video", contentType: "video/mp4", size: 2_000 };
const SECRET = { ...IMAGE, id: "f_sec", name: "passport.png", contentType: "image/png", exposure: "secret" };
const NO_EXPOSURE: Record<string, unknown> = { ...IMAGE, id: "f_noexp" };
delete NO_EXPOSURE.exposure;

const FILES: Record<string, Record<string, unknown>> = Object.fromEntries(
  [IMAGE, AUDIO, BIG_AUDIO, VIDEO, SECRET, NO_EXPOSURE].map((f) => [f.id as string, f]),
);

const LISTING = {
  workspaceId: "ws_1",
  folder: null,
  breadcrumbs: [],
  folders: [FOLDER],
  files: [IMAGE, SECRET],
  total: 3,
  nextCursor: "c_2",
};

// Real-looking temporary links: the package must hand them over, never fetch them.
const COMMON_LINK = "https://kstonebaselibrary.blob.core.windows.net/library/u_1/ws_1/profile.jpg?sv=2025&sig=SIGNATURE";
const REDEEM_LINK = `${API_URL}/library/redeem/T0k3n_one_time_base64url`;
const APPROVAL_URL = "https://kstonebase.test/workspace/ws_1/library/access-requests/ar_1";

const IMAGE_B64 = Buffer.from("fake-jpeg-bytes").toString("base64");
const AUDIO_B64 = Buffer.from("fake-mp3-bytes").toString("base64");

const PENDING_REQUEST = {
  requestId: "ar_1",
  fileId: "f_sec",
  status: "pending",
  expiresAt: "2026-10-19T01:10:00Z",
  approvalUrl: APPROVAL_URL,
};

function apiError(status: number, envelope: string, message: string, details?: Record<string, unknown>): Reply {
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

/** Every URL any fetch stub of this file was called with (policy reads included). */
let everyFetchedUrl: string[] = [];

function localPolicy(url: URL): Reply {
  return {
    status: 200,
    json: {
      items: url.searchParams.getAll("target").map((t) => {
        const [type, ...rest] = t.split(":");
        return {
          target: { type, id: rest.join(":") },
          policy: {
            schemaVersion: 1,
            mode: "local",
            source: "workspace_local",
            policyRevision: "wp1_AAAAAAAAAAAAAAAAAAAAAA",
            instructions: null,
            instructionsOmitted: false,
          },
        };
      }),
    },
  };
}

/** A recording fetch stub; `reply` decides each Library response. */
function recorder(reply: (req: SentRequest) => Reply) {
  const sent: SentRequest[] = [];
  const policySent: SentRequest[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    everyFetchedUrl.push(href);
    const url = new URL(href);
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
    const isPolicy = req.method === "GET" && req.path === "/api/mcp/agent-policy";
    (isPolicy ? policySent : sent).push(req);
    const r = isPolicy ? localPolicy(url) : reply(req);
    return new Response(r.raw ?? JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": r.raw ? "text/html" : "application/json" },
    });
  });
  return { sent, policySent, fetcher: fetcher as unknown as typeof fetch };
}

/** The fake API's success replies by route. */
function libraryApi(req: SentRequest): Reply {
  const notFound = apiError(404, "NOT_FOUND", "Not found.", { code: "NOT_FOUND" });
  let m = req.path.match(/^\/api\/mcp\/workspaces\/([^/]+)\/library$/);
  if (m && req.method === "GET") return { status: 200, json: { ...LISTING, workspaceId: decodeURIComponent(m[1]) } };
  m = req.path.match(/^\/api\/mcp\/library\/files\/([^/]+)(\/[a-z-]+)?$/);
  if (m) {
    const file = FILES[decodeURIComponent(m[1])];
    if (!file) return notFound;
    const rest = m[2] ?? "";
    if (req.method === "GET" && rest === "") return { status: 200, json: { ...file, uploadedBy: "Ana" } };
    if (req.method === "POST" && rest === "/link") {
      return file.exposure === "common"
        ? { status: 200, json: { url: COMMON_LINK, expiresAt: "2026-10-19T01:15:00Z" } }
        : apiError(409, "CONFLICT", "Approval required.", { code: "LIBRARY_APPROVAL_REQUIRED" });
    }
    if (req.method === "GET" && rest === "/content") {
      if (file.exposure !== "common") return apiError(409, "CONFLICT", "Approval required.", { code: "LIBRARY_APPROVAL_REQUIRED" });
      const base64 = file.kind === "audio" ? AUDIO_B64 : IMAGE_B64;
      return { status: 200, json: { fileId: file.id, name: file.name, contentType: file.contentType, size: file.size, base64 } };
    }
    if (req.method === "POST" && rest === "/access-requests") {
      return file.exposure === "secret"
        ? { status: 201, json: { ...PENDING_REQUEST, fileId: file.id } }
        : apiError(409, "CONFLICT", "Not secret.", { code: "LIBRARY_NOT_SECRET" });
    }
  }
  m = req.path.match(/^\/api\/mcp\/library\/access-requests\/([^/]+)$/);
  if (m && req.method === "GET") return m[1] === "ar_1" ? { status: 200, json: PENDING_REQUEST } : notFound;
  return notFound;
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
const DISCOVERY = makeConfig();

async function connect(fetcher: typeof fetch, config: ResolvedConfig = WORKSPACE_ONLY) {
  const client = new KstonebaseClient({ apiUrl: config.apiUrl, token: TOKEN, fetcher });
  const server = buildServer({ config, client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "library-tools-test", version: "0.0.0" });
  await mcp.connect(clientSide);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

type Block = { type: string; text?: string; data?: string; mimeType?: string };

async function call(mcp: Client, name: string, args: Record<string, unknown>) {
  const res = await mcp.callTool({ name, arguments: args });
  const content = res.content as Block[];
  return {
    isError: res.isError === true,
    data: (res.structuredContent ?? {}) as Record<string, any>,
    content,
    text: content[0]?.text ?? "",
    texts: content.filter((c) => c.type === "text").map((c) => c.text ?? ""),
  };
}

/** One call against `reply`, on a fresh server. */
async function once(
  name: string,
  args: Record<string, unknown>,
  reply: (req: SentRequest) => Reply = libraryApi,
  config: ResolvedConfig = WORKSPACE_ONLY,
) {
  const rec = recorder(reply);
  const { mcp, close } = await connect(rec.fetcher, config);
  try {
    return { ...(await call(mcp, name, args)), sent: rec.sent, policySent: rec.policySent };
  } finally {
    await close();
  }
}

let stderrLines: string[] = [];

beforeEach(() => {
  everyFetchedUrl = [];
  stderrLines = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  // Spec §1 and §5: no code path ever fetches a returned link — no one-time
  // `/library/redeem/` link, no storage link, no approval page. Every request
  // goes to the configured Kstonebase API's MCP routes.
  for (const url of everyFetchedUrl) {
    expect(url).not.toContain("/library/redeem/");
    expect(url.startsWith(`${API_URL}/api/mcp/`), url).toBe(true);
  }
  // Links never reach the logs either.
  const logs = stderrLines.join("");
  expect(logs).not.toContain("/library/redeem/");
  expect(logs).not.toContain("sig=SIGNATURE");
  vi.restoreAllMocks();
});

/** Minimal valid arguments for every tool (Workspace from the binding). */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  list_library: {},
  read_library_file: { fileId: "f_img" },
  get_library_file_link: { fileId: "f_img" },
  read_library_file_content: { fileId: "f_img" },
  request_library_file_access: { fileId: "f_sec", purpose: "Use as a reference image in a generation" },
  read_library_file_access: { requestId: "ar_1" },
};

// ──────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────

describe("Library tools — discovery", () => {
  it("advertises the six tools last, with the contract's titles, descriptions, annotations and schemas", async () => {
    const { fetcher } = recorder(libraryApi);
    const { mcp, close } = await connect(fetcher);
    const { tools } = await mcp.listTools();
    const reference = await contractSchemas();
    expect(tools.slice(-6).map((t) => t.name)).toEqual(LIBRARY_TOOLS);
    for (const name of LIBRARY_TOOLS) {
      const tool = tools.find((t) => t.name === name)!;
      expect(tool.title, name).toBe(CONTRACT[name].title);
      expect(tool.description, name).toBe(CONTRACT[name].description);
      expect(tool.annotations, name).toEqual(CONTRACT[name].annotations);
      expect(tool.inputSchema, name).toEqual(reference[name]);
    }
    await close();
  });

  it("offers no Library write besides the access request (no upload, rename, move, delete, exposure or approve)", async () => {
    const { fetcher } = recorder(libraryApi);
    const { mcp, close } = await connect(fetcher);
    const { tools } = await mcp.listTools();
    const library = tools.filter((t) => /library/.test(t.name)).map((t) => t.name);
    expect(library.sort()).toEqual([...LIBRARY_TOOLS].sort());
    const writes = tools.filter((t) => LIBRARY_TOOLS.includes(t.name) && t.annotations?.readOnlyHint !== true);
    expect(writes.map((t) => t.name)).toEqual(["request_library_file_access"]);
    // Contract §5: the schemas carry no policy precondition, credential, URL or approval input.
    for (const name of LIBRARY_TOOLS) {
      const props = Object.keys((tools.find((t) => t.name === name)!.inputSchema as any).properties ?? {});
      for (const key of props) expect(key, `${name}.${key}`).not.toMatch(/policy|token|password|url|approv|exposure/i);
    }
    await close();
  });

  it("tells the model links are temporary, to pass them on immediately and never fetch a one-time link through Kstonebase", () => {
    expect(CONTRACT.get_library_file_link.description).toMatch(/temporary/);
    expect(CONTRACT.get_library_file_link.description).toMatch(/pass it immediately/);
    expect(CONTRACT.get_library_file_link.description).toMatch(/never store it/);
    expect(CONTRACT.read_library_file_access.description).toMatch(/one-time link/);
    expect(CONTRACT.read_library_file_access.description).toMatch(/never fetch or open it through Kstonebase/);
    for (const name of LIBRARY_TOOLS.slice(0, 5)) expect(CONTRACT[name].description.endsWith(SCOPE), name).toBe(true);
  });

  it("is declared in the ChatGPT app manifest with the same annotations", () => {
    const manifest = JSON.parse(readFileSync(new URL("../chatgpt-app-submission.json", import.meta.url), "utf8")) as {
      tools: Record<string, { annotations: Record<string, boolean>; justifications: Record<string, string> }>;
    };
    for (const name of LIBRARY_TOOLS) {
      expect(manifest.tools, name).toHaveProperty(name);
      expect(manifest.tools[name].annotations, name).toEqual(CONTRACT[name].annotations);
      expect(Object.keys(manifest.tools[name].justifications).sort(), name).toEqual([
        "destructive_justification",
        "open_world_justification",
        "read_only_justification",
      ]);
    }
  });

  it("refuses out-of-contract arguments before any request", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["list_library", { limit: 101 }],
      ["list_library", { limit: 0 }],
      ["list_library", { workspaceId: "" }],
      ["read_library_file", {}],
      ["get_library_file_link", { fileId: "" }],
      ["request_library_file_access", { fileId: "f_sec" }],
      ["request_library_file_access", { fileId: "f_sec", purpose: "" }],
      ["request_library_file_access", { fileId: "f_sec", purpose: "x".repeat(501) }],
      ["read_library_file_access", {}],
    ];
    for (const [name, args] of cases) {
      const out = await once(name, args);
      expect(out.isError, `${name} ${JSON.stringify(args).slice(0, 60)}`).toBe(true);
      expect(out.sent).toHaveLength(0);
    }
    const ok500 = await once("request_library_file_access", { fileId: "f_sec", purpose: "x".repeat(500) });
    expect(ok500.isError).toBe(false);
  });

  it.each([".", ".."])("refuses the path-collapsing id %j before any request", async (bad) => {
    for (const [name, key] of [
      ["read_library_file", "fileId"],
      ["read_library_file_access", "requestId"],
    ] as const) {
      const out = await once(name, { [key]: bad });
      expect(out.isError).toBe(true);
      expect(out.text.startsWith("VALIDATION_ERROR:")).toBe(true);
      expect(out.sent).toHaveLength(0);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Forwarding and results
// ──────────────────────────────────────────────────────────────────────────

describe("Library tools — forwarding", () => {
  it("list_library → GET …/workspaces/<bound>/library, Bearer only, listing unchanged, Workspace notice", async () => {
    const out = await once("list_library", {});
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toEqual(LISTING);
    expect(JSON.parse(out.text)).toEqual(LISTING);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]).toMatchObject({ method: "GET", url: `${API_URL}/api/mcp/workspaces/ws_1/library`, body: undefined });
    expect(out.sent[0].headers).toEqual({ authorization: `Bearer ${TOKEN}`, accept: "application/json" });
    expect(out.policySent.map((r) => r.query.target)).toEqual(["workspace:ws_1"]);
    expect(out.texts.at(-1)).toContain("ws_1");
  });

  it("list_library forwards an explicit Workspace, folder, cursor and limit", async () => {
    const out = await once("list_library", { workspaceId: "ws/2", folderId: "fo_1", cursor: "c_2", limit: 100 });
    expect(out.isError, out.text).toBe(false);
    expect(out.sent[0].path).toBe("/api/mcp/workspaces/ws%2F2/library");
    expect(out.sent[0].query).toEqual({ folderId: "fo_1", cursor: "c_2", limit: "100" });
    expect(out.data.workspaceId).toBe("ws/2");
  });

  it("read_library_file → GET …/library/files/:id, metadata with uploadedBy, notice of the file's Workspace", async () => {
    const out = await once("read_library_file", { fileId: "f_sec" }, libraryApi, DISCOVERY);
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toEqual({ ...SECRET, uploadedBy: "Ana" });
    expect(out.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/mcp/library/files/f_sec"]);
    expect(out.policySent.map((r) => r.query.target)).toEqual(["workspace:ws_1"]);
  });

  it("get_library_file_link → POST …/link without a body; hands the link over with the temporary-link guidance", async () => {
    const out = await once("get_library_file_link", { fileId: "f_img" });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toEqual({ url: COMMON_LINK, expiresAt: "2026-10-19T01:15:00Z" });
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]).toMatchObject({ method: "POST", path: "/api/mcp/library/files/f_img/link", body: undefined });
    expect(out.sent[0].headers["content-type"]).toBeUndefined();
    expect(out.texts[1]).toBe(
      "Temporary link, valid until 2026-10-19T01:15:00Z. Pass it now, directly, to the tool that needs the file. Do not store it in specifications, notes or memory.",
    );
    // The link itself is never requested.
    expect(everyFetchedUrl).not.toContain(COMMON_LINK);
  });

  it("read_library_file_content returns a common image as an MCP image block (metadata first, then content)", async () => {
    const out = await once("read_library_file_content", { fileId: "f_img" });
    expect(out.isError, out.text).toBe(false);
    expect(out.sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/mcp/library/files/f_img",
      "GET /api/mcp/library/files/f_img/content",
    ]);
    expect(out.content[1]).toEqual({ type: "image", data: IMAGE_B64, mimeType: "image/jpeg" });
    expect(out.data).toEqual({
      fileId: "f_img",
      workspaceId: "ws_1",
      name: "profile.jpg",
      kind: "image",
      contentType: "image/jpeg",
      size: 123_456,
      exposure: "common",
      folderPath: "",
    });
    expect(JSON.stringify(out.data)).not.toContain(IMAGE_B64);
    expect(out.policySent.map((r) => r.query.target)).toEqual(["workspace:ws_1"]);
  });

  it("read_library_file_content returns common audio up to 10,000,000 bytes as an MCP audio block", async () => {
    const out = await once("read_library_file_content", { fileId: "f_aud" });
    expect(out.isError, out.text).toBe(false);
    expect(out.content[1]).toEqual({ type: "audio", data: AUDIO_B64, mimeType: "audio/mpeg" });
  });

  it("request_library_file_access → POST …/access-requests {purpose}; pending request plus approval guidance", async () => {
    const out = await once("request_library_file_access", MINIMAL_ARGS.request_library_file_access);
    expect(out.isError, out.text).toBe(false);
    expect(out.sent).toHaveLength(1);
    expect(out.sent[0]).toMatchObject({
      method: "POST",
      path: "/api/mcp/library/files/f_sec/access-requests",
      body: { purpose: "Use as a reference image in a generation" },
    });
    expect(out.sent[0].headers["x-kstonebase-policy-revision"]).toBeUndefined();
    expect(out.data).toEqual(PENDING_REQUEST);
    expect(out.texts[1]).toBe(
      `Access requested; nothing is shared yet. Ask the user to approve this request in Kstonebase: ${APPROVAL_URL}. It expires at 2026-10-19T01:10:00Z. After the user approves, call read_library_file_access with requestId ar_1.`,
    );
    expect(everyFetchedUrl).not.toContain(APPROVAL_URL);
  });

  it("read_library_file_access returns the one-time link only once approved, and never fetches it", async () => {
    const approved = { requestId: "ar_1", fileId: "f_sec", status: "approved", expiresAt: "2026-10-19T01:05:00Z", url: REDEEM_LINK };
    const out = await once("read_library_file_access", { requestId: "ar_1" }, () => ({ status: 200, json: approved }));
    expect(out.isError, out.text).toBe(false);
    expect(out.sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/mcp/library/access-requests/ar_1"]);
    expect(out.data).toEqual(approved);
    expect(out.texts[1]).toBe(
      "Approved. This one-time link works once and expires at 2026-10-19T01:05:00Z. Hand it directly to the tool that needs the file; never fetch or open it through Kstonebase, and never store it.",
    );
  });

  it.each([
    ["pending", "Still waiting for a person to decide."],
    ["rejected", "Rejected. No link was issued"],
    ["expired", "Expired without a usable link."],
    ["redeemed", "The one-time link was already used."],
    ["revoked", "No link is available for this request."],
  ])("read_library_file_access %s: no url is ever handed over", async (status, guidance) => {
    // Even if a server sent a url for a non-approved request, it is dropped.
    const body = { requestId: "ar_1", fileId: "f_sec", status, expiresAt: "2026-10-19T01:10:00Z", url: REDEEM_LINK };
    const out = await once("read_library_file_access", { requestId: "ar_1" }, () => ({ status: 200, json: body }));
    expect(out.isError, out.text).toBe(false);
    expect(out.data).not.toHaveProperty("url");
    expect(out.texts.join("\n")).not.toContain("/library/redeem/");
    expect(out.texts[1].startsWith(guidance)).toBe(true);
  });

  it("an approved request without a link says so instead of inventing one", async () => {
    const body = { requestId: "ar_1", fileId: "f_sec", status: "approved", expiresAt: "2026-10-19T01:05:00Z" };
    const out = await once("read_library_file_access", { requestId: "ar_1" }, () => ({ status: 200, json: body }));
    expect(out.texts[1]).toBe(
      "Approved, but the one-time link is no longer available. Request access again if you still need the file.",
    );
  });

  it("the link and access tools carry no Workspace notice (their answers name no Workspace)", async () => {
    for (const name of ["get_library_file_link", "request_library_file_access", "read_library_file_access"]) {
      const out = await once(name, MINIMAL_ARGS[name]);
      expect(out.isError, out.text).toBe(false);
      expect(out.policySent, name).toHaveLength(0);
      expect(out.texts, name).toHaveLength(2);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Secret files
// ──────────────────────────────────────────────────────────────────────────

describe("Library tools — secret files", () => {
  const APPROVAL_TEXT = `LIBRARY_APPROVAL_REQUIRED: ${MESSAGES.LIBRARY_APPROVAL_REQUIRED}`;

  it("read_library_file_content never requests the content of a secret file", async () => {
    const out = await once("read_library_file_content", { fileId: "f_sec" });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith(APPROVAL_TEXT)).toBe(true);
    expect(out.data.code).toBe("LIBRARY_APPROVAL_REQUIRED");
    expect(out.sent.map((r) => r.path)).toEqual(["/api/mcp/library/files/f_sec"]);
    expect(everyFetchedUrl.some((u) => u.endsWith("/content"))).toBe(false);
    expect(out.content.every((c) => c.type === "text")).toBe(true);
  });

  it("read_library_file_content fails closed when the exposure is missing", async () => {
    const out = await once("read_library_file_content", { fileId: "f_noexp" });
    expect(out.text.startsWith(APPROVAL_TEXT)).toBe(true);
    expect(everyFetchedUrl.some((u) => u.endsWith("/content"))).toBe(false);
  });

  it("read_library_file_content maps a file that turned secret in between (API refusal)", async () => {
    // Metadata says common, the content route then refuses: the race is closed by the API.
    const out = await once("read_library_file_content", { fileId: "f_img" }, (req) =>
      req.path.endsWith("/content")
        ? apiError(409, "CONFLICT", "Approval required.", { code: "LIBRARY_APPROVAL_REQUIRED" })
        : libraryApi(req),
    );
    expect(out.text.startsWith(APPROVAL_TEXT)).toBe(true);
    expect(out.content.every((c) => c.type === "text")).toBe(true);
  });

  it("get_library_file_link on a secret file answers approval required naming request_library_file_access", async () => {
    const out = await once("get_library_file_link", { fileId: "f_sec" });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith(APPROVAL_TEXT)).toBe(true);
    expect(out.text).toContain("request_library_file_access");
    expect(out.text).toContain("Client settings that allow all actions never replace that approval.");
  });

  it.each([
    ["a video", "f_vid"],
    ["audio above 10,000,000 bytes", "f_big"],
  ])("read_library_file_content refuses %s without requesting it, pointing to the link", async (_label, fileId) => {
    const out = await once("read_library_file_content", { fileId });
    expect(out.isError).toBe(true);
    expect(out.text.startsWith(`LIBRARY_CONTENT_TOO_LARGE: ${MESSAGES.LIBRARY_CONTENT_TOO_LARGE}`)).toBe(true);
    expect(out.text).toContain("get_library_file_link");
    expect(everyFetchedUrl.some((u) => u.endsWith("/content"))).toBe(false);
  });

  it("read_library_file_content refuses a content answer that is not image or audio", async () => {
    const out = await once("read_library_file_content", { fileId: "f_img" }, (req) =>
      req.path.endsWith("/content")
        ? { status: 200, json: { fileId: "f_img", name: "x", contentType: "video/mp4", size: 1, base64: "AA==" } }
        : libraryApi(req),
    );
    expect(out.text.startsWith("LIBRARY_CONTENT_TOO_LARGE:")).toBe(true);
    expect(out.content.every((c) => c.type === "text")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Error mapping (spec §3)
// ──────────────────────────────────────────────────────────────────────────

describe("Library tools — error mapping", () => {
  const CASES: Array<[string, string, Reply, string]> = [
    ["get_library_file_link", "LIBRARY_APPROVAL_REQUIRED", apiError(409, "CONFLICT", "x", { code: "LIBRARY_APPROVAL_REQUIRED" }), MESSAGES.LIBRARY_APPROVAL_REQUIRED],
    ["read_library_file_content", "LIBRARY_CONTENT_TOO_LARGE", apiError(409, "CONFLICT", "x", { code: "LIBRARY_CONTENT_TOO_LARGE" }), MESSAGES.LIBRARY_CONTENT_TOO_LARGE],
    ["request_library_file_access", "LIBRARY_NOT_SECRET", apiError(409, "CONFLICT", "x", { code: "LIBRARY_NOT_SECRET" }), MESSAGES.LIBRARY_NOT_SECRET],
    ["request_library_file_access", "LIBRARY_TOO_MANY_PENDING", apiError(429, "RATE_LIMITED", "x", { code: "LIBRARY_TOO_MANY_PENDING" }), MESSAGES.LIBRARY_TOO_MANY_PENDING],
  ];

  it.each(CASES)("%s maps details.code %s to the spec message", async (name, code, reply, message) => {
    // The content tool reads common metadata first, then hits the refusal.
    const out = await once(name, MINIMAL_ARGS[name], (req) =>
      req.method === "GET" && /\/library\/files\/[^/]+$/.test(req.path) ? libraryApi(req) : reply,
    );
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe(code);
    expect(out.data.message).toBe(message);
    expect(out.text.startsWith(`${code}: ${message}\n\n`)).toBe(true);
  });

  it("the envelope code alone is enough (no details.code)", async () => {
    const out = await once("get_library_file_link", { fileId: "f_img" }, () => ({
      status: 409,
      json: { error: { code: "LIBRARY_APPROVAL_REQUIRED", message: "x" } },
    }));
    expect(out.data.code).toBe("LIBRARY_APPROVAL_REQUIRED");
  });

  it.each(LIBRARY_TOOLS)("%s: any 404 is not found or outside this credential's scope", async (name) => {
    for (const reply of [
      apiError(404, "NOT_FOUND", "Workspace not found.", { code: "NOT_FOUND" }),
      // A deployment without the Library (or its Website proxy) answers HTML.
      { status: 404, raw: "<html>Not Found</html>" },
    ]) {
      const out = await once(name, MINIMAL_ARGS[name], () => reply);
      expect(out.isError, name).toBe(true);
      expect(out.data.code).toBe("NOT_FOUND");
      expect(out.data.message).toBe(MESSAGES.NOT_FOUND);
      expect(out.data.remediation).toContain("Product-only token or binding sees no Library");
    }
  });

  it("a purpose refused by the API is VALIDATION_ERROR with its field", async () => {
    const out = await once("request_library_file_access", MINIMAL_ARGS.request_library_file_access, () =>
      apiError(422, "VALIDATION_ERROR", "purpose is required", { code: "VALIDATION_ERROR", field: "purpose", problem: "too-long" }),
    );
    expect(out.data).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "purpose is required",
      details: { field: "purpose", problem: "too-long" },
    });
  });

  it("credential failures keep the shared vocabulary", async () => {
    const auth = await once("list_library", {}, () => apiError(401, "UNAUTHORIZED", "Invalid token."));
    expect(auth.data.code).toBe("AUTH_FAILED");
    const scope = await once("request_library_file_access", MINIMAL_ARGS.request_library_file_access, () =>
      apiError(403, "FORBIDDEN", "Token lacks write scope.", { code: "TOKEN_SCOPE_INSUFFICIENT" }),
    );
    expect(scope.data.code).toBe("TOKEN_SCOPE_INSUFFICIENT");
  });

  it("failed results carry no Workspace notice", async () => {
    const out = await once("list_library", {}, () => apiError(404, "NOT_FOUND", "x"));
    expect(out.policySent).toHaveLength(0);
    expect(out.content).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Workspace targeting and Product-only bindings (spec §1)
// ──────────────────────────────────────────────────────────────────────────

describe("Library tools — Workspace targeting", () => {
  it("a Product-only binding sees no Library: not found, without any request", async () => {
    const out = await once("list_library", {}, libraryApi, PRODUCT_ONLY);
    expect(out.isError).toBe(true);
    expect(out.data.code).toBe("NOT_FOUND");
    expect(out.data.message).toBe(MESSAGES.NOT_FOUND);
    expect(out.sent).toHaveLength(0);
    expect(out.policySent).toHaveLength(0);
  });

  it("a Product-only credential gets the API's 404 as not found or outside this credential's scope", async () => {
    const out = await once("list_library", { workspaceId: "ws_1" }, () => apiError(404, "NOT_FOUND", "Not found."), PRODUCT_ONLY);
    expect(out.sent.map((r) => r.path)).toEqual(["/api/mcp/workspaces/ws_1/library"]);
    expect(out.data.message).toBe(MESSAGES.NOT_FOUND);
  });

  it("a Workspace+Product binding lists the bound Workspace, never the Product", async () => {
    const out = await once("list_library", {}, libraryApi, WORKSPACE_AND_PRODUCT);
    expect(out.isError, out.text).toBe(false);
    expect(out.sent.map((r) => r.path)).toEqual(["/api/mcp/workspaces/ws_1/library"]);
    expect(everyFetchedUrl.some((u) => u.includes("p_1"))).toBe(false);
  });

  it("without any binding, list_library asks for a Workspace (WORKSPACE_NOT_BOUND), without any request", async () => {
    const out = await once("list_library", {}, libraryApi, DISCOVERY);
    expect(out.data.code).toBe("WORKSPACE_NOT_BOUND");
    expect(out.sent).toHaveLength(0);
  });

  it("the file and request tools need no binding: their ids address the API directly", async () => {
    for (const name of LIBRARY_TOOLS.slice(1)) {
      const out = await once(name, MINIMAL_ARGS[name], libraryApi, PRODUCT_ONLY);
      expect(out.isError, `${name}: ${out.text}`).toBe(false);
      expect(out.sent.every((r) => !r.path.includes("p_1")), name).toBe(true);
    }
  });
});
