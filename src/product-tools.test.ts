// New Products always use the flexible document model (Kstonebase MCP spec
// specification-authoring/protocol.md, PBI 271): create_product has no
// management-type input and never forwards one, and the Product tool
// descriptions offer no type choice. The server is built exactly as every
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

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function stubApi() {
  const sent: Sent[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const raw = typeof init?.body === "string" ? init.body : undefined;
    sent.push({ method: init?.method ?? "GET", path: url.pathname, body: raw === undefined ? undefined : JSON.parse(raw) });
    const json =
      url.pathname === "/api/mcp/agent-policy"
        ? { items: [] }
        : { id: "p_new", name: "Billing", workspaceId: "ws_1" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
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
  it("has no specificationManagementType input and describes the flexible document model", async () => {
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
        "expectedPolicyRevision",
      ]);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/specificationManagementType|web_application/);
      expect(tool.description).toBe(
        "Create a new Product inside the bound Workspace. New Products use the flexible document model. Requires a Workspace-scope binding; product-allowlist credentials cannot create Products.",
      );
    } finally {
      await close();
    }
  });

  it("never forwards a management type, even when an older agent sends one", async () => {
    const { sent, fetcher } = stubApi();
    const { mcp, close } = await connect(fetcher);
    try {
      const res = await mcp.callTool({
        name: "create_product",
        arguments: { name: "Billing", description: "Payments", tags: ["pay"], specificationManagementType: "web_application" },
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
