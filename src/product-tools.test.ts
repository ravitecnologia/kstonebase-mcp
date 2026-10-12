// New Products always use the flexible document model (Kstonebase MCP spec
// specification-authoring/protocol.md, PBI 271): create_product offers no
// management-type choice and the Product tool descriptions offer none either.
// A deprecated, free-form specificationManagementType stays so an explicit
// request from an older agent reaches the API and gets its actionable
// PRODUCT_TYPE_UNSUPPORTED refusal instead of being silently stripped. The server is built exactly as every
// transport builds it (buildServer) and driven by the SDK client over an
// in-memory transport, against a recording stub of the Website proxy.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_PRODUCT_TOOL_TEST";
const API_URL = "https://api.kstonebase.test";

const CONFIG: ResolvedConfig = {
  apiUrl: API_URL,
  apiUrlSource: "argument",
  token: TOKEN,
  workspaceId: "ws_1",
  workspaceSource: "config-file",
  productId: null,
  productSource: "none",
  bindingMode: "workspace",
  telemetryEnabled: false,
  allowInsecure: false,
};

const DEPRECATED =
  'Deprecated — omit it. New Products always use the flexible document model; any value other than "free" is refused by the server with PRODUCT_TYPE_UNSUPPORTED.';

const REFUSAL = {
  error: {
    code: "BAD_REQUEST",
    message: "New Products always use the flexible document model.",
    details: {
      code: "PRODUCT_TYPE_UNSUPPORTED",
      requested: "web_application",
      supported: ["free"],
      hint: "Omit specificationManagementType; new Products always use the flexible document model.",
    },
  },
};

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function stubApi(productReply?: { status: number; json: unknown }) {
  const sent: Sent[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    sent.push({ method: init?.method ?? "GET", path: url.pathname, body: raw === undefined ? undefined : JSON.parse(raw) });
    const reply =
      url.pathname === "/api/mcp/agent-policy"
        ? { status: 200, json: { items: [] } }
        : (productReply ?? { status: 200, json: { id: "p_new", name: "Billing", workspaceId: "ws_1" } });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { sent, fetcher: fetcher as unknown as typeof fetch };
}

async function connect(fetcher: typeof fetch) {
  const client = new KstonebaseClient({ apiUrl: API_URL, token: TOKEN, fetcher });
  const server = buildServer({ config: CONFIG, client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "product-tools-test", version: "0.0.0" });
  await mcp.connect(clientSide);
  return {
    mcp,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("create_product (PBI 271)", () => {
  it("keeps specificationManagementType only as a deprecated, optional free-form string, never a choice", async () => {
    const { fetcher } = stubApi();
    const { mcp, close } = await connect(fetcher);
    try {
      const { tools } = await mcp.listTools();
      const tool = tools.find((t) => t.name === "create_product")!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
        "workspaceId",
        "name",
        "description",
        "tags",
        "specificationManagementType",
        "expectedPolicyRevision",
      ]);
      const field = (tool.inputSchema.properties as Record<string, Record<string, unknown>>).specificationManagementType;
      expect(field).toEqual({ type: "string", description: DEPRECATED });
      expect(field).not.toHaveProperty("enum");
      expect(tool.inputSchema.required ?? []).not.toContain("specificationManagementType");
      expect(JSON.stringify(tool.inputSchema)).not.toContain("web_application");
      expect(tool.description).not.toMatch(/specificationManagementType|web_application|Web Application/);
      expect(tool.description).toBe(
        "Create a new Product inside the bound Workspace. New Products use the flexible document model. Requires a Workspace-scope binding; product-allowlist credentials cannot create Products.",
      );
    } finally {
      await close();
    }
  });

  it("does not send a management type when the agent omits it", async () => {
    const { sent, fetcher } = stubApi();
    const { mcp, close } = await connect(fetcher);
    try {
      const res = await mcp.callTool({
        name: "create_product",
        arguments: { name: "Billing", description: "Payments", tags: ["pay"] },
      });
      expect(res.isError).not.toBe(true);
      const creates = sent.filter((r) => r.path === "/api/mcp/workspaces/ws_1/products");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.method).toBe("POST");
      expect(creates[0]!.body).toEqual({ name: "Billing", description: "Payments", tags: ["pay"] });
      expect(JSON.stringify(creates[0]!.body)).not.toContain("specificationManagementType");
    } finally {
      await close();
    }
  });

  it("forwards an explicit legacy value unchanged and surfaces the API refusal with its hint", async () => {
    const { sent, fetcher } = stubApi({ status: 400, json: REFUSAL });
    const { mcp, close } = await connect(fetcher);
    try {
      const res = await mcp.callTool({
        name: "create_product",
        arguments: { name: "Billing", specificationManagementType: "web_application" },
      });
      const creates = sent.filter((r) => r.path === "/api/mcp/workspaces/ws_1/products");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.body).toEqual({ name: "Billing", specificationManagementType: "web_application" });
      expect(res.isError).toBe(true);
      const failure = res.structuredContent as { code: string; message: string; details?: Record<string, unknown> };
      // The existing default mapping classifies BAD_REQUEST + details.code
      // PRODUCT_TYPE_UNSUPPORTED by status (pinned in errors.test.ts); the
      // API's message and actionable hint reach the agent unchanged.
      expect(failure.code).toBe("INTERNAL_ERROR");
      expect(failure.message).toBe("New Products always use the flexible document model.");
      expect(failure.details).toEqual({
        hint: "Omit specificationManagementType; new Products always use the flexible document model.",
      });
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("New Products always use the flexible document model.");
      expect(text).toContain("Omit specificationManagementType; new Products always use the flexible document model.");
    } finally {
      await close();
    }
  });

  it("forwards an explicit \"free\" unchanged", async () => {
    const { sent, fetcher } = stubApi();
    const { mcp, close } = await connect(fetcher);
    try {
      await mcp.callTool({ name: "create_product", arguments: { name: "Billing", specificationManagementType: "free" } });
      const creates = sent.filter((r) => r.path === "/api/mcp/workspaces/ws_1/products");
      expect(creates[0]!.body).toEqual({ name: "Billing", specificationManagementType: "free" });
    } finally {
      await close();
    }
  });
});

describe("Product tool descriptions offer no management-type choice (PBI 271)", () => {
  it("describes read_product, list_specifications and create_free_specification without Free / Web Application wording", async () => {
    const { fetcher } = stubApi();
    const { mcp, close } = await connect(fetcher);
    try {
      const { tools } = await mcp.listTools();
      const byName = (name: string) => tools.find((t) => t.name === name)!;
      expect(byName("read_product").description).toBe(
        "Read a Product's metadata: name, description and member-of Workspace (when set). Read-only.",
      );
      expect(byName("list_specifications").description).toContain(
        "structured legacy Products accept the BUSINESS/UX/DESIGN_SYSTEM type filter",
      );
      for (const name of ["read_product", "list_specifications", "create_free_specification", "create_product"]) {
        const tool = byName(name);
        const text = `${tool.title ?? ""} ${tool.description ?? ""}`;
        expect(text, name).not.toMatch(/Free product|Free scopes|Web Application|specificationManagementType/);
      }
    } finally {
      await close();
    }
  });
});
