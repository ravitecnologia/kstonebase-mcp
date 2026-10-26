// Automatic approval of agent changes (PBI 392; Kstonebase Business ›
// features/agent-auto-approval.md): the write tools open a draft when a
// Reviewed target refuses the write, write, then request review when the API
// says the caller is eligible — and only then. Same contract as the
// Website-hosted transport.

import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { buildServer } from "./server.js";

const TOKEN = "kstonebase_pat_AUTO_APPROVAL_TEST";
const API_URL = "https://api.kstonebase.test";
const REVISION = "wp1_AAAAAAAAAAAAAAAAAAAAAA";

type Route = { status: number; body: unknown };
let routes: Record<string, Route | Route[]> = {};
let requests: Array<{ key: string; headers: Record<string, string> }> = [];
const closers: Array<() => Promise<void>> = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === "/api/mcp/agent-policy") {
    const items = url.searchParams.getAll("target").map((t) => {
      const [type, ...rest] = t.split(":");
      return {
        target: { type, id: rest.join(":") },
        policy: { schemaVersion: 1, mode: "local", source: "workspace_local", policyRevision: REVISION, instructions: null, instructionsOmitted: false },
      };
    });
    return json(200, { items });
  }
  const key = `${init?.method ?? "GET"} ${url.pathname}`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
  requests.push({ key, headers });
  const route = routes[key];
  if (!route) return json(404, { error: { code: "NOT_FOUND", message: key } });
  const next = Array.isArray(route) ? (route.length > 1 ? route.shift()! : route[0]!) : route;
  return json(next.status, next.body);
}) as typeof fetch;

function config(): ResolvedConfig {
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
  };
}

async function call(name: string, args: Record<string, unknown>) {
  const client = new KstonebaseClient({ apiUrl: API_URL, token: TOKEN, fetcher });
  const server = buildServer({ config: config(), client });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "auto-approval-test", version: "0.0.0" });
  await mcp.connect(clientSide);
  closers.push(async () => {
    await mcp.close();
    await server.close();
  });
  const res = (await mcp.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]!.text;
  return { isError: res.isError === true, text, body: res.isError ? undefined : JSON.parse(text) };
}

/** The tool's API requests, without authoring context reads. */
const calls = () => requests.map((r) => r.key).filter((k) => !k.includes("authoring-context"));

const product = (eligible: boolean) => ({
  status: 200,
  body: { id: "p1", autoApproveAgentChanges: eligible, autoApproval: { enabled: eligible, eligible } },
});
const draft = { id: "s1", productId: "p1", status: "DRAFT", version: 4, approvedVersion: 2 };
const approved = {
  status: 200,
  body: {
    spec: { ...draft, status: "REVIEWED", approvedVersion: 3 },
    autoApproval: { applied: true, status: "REVIEWED", approvedVersion: 3, openQuestionsCount: 0 },
  },
};
const locked = {
  status: 403,
  body: { error: { code: "SPEC_LOCKED", message: "locked", details: { code: "SPEC_LOCKED", status: "REVIEWED", hint: "call start_new_version first" } } },
};
const section = { specId: "s1", sectionPath: "## Scope", newSection: "## Scope\n\nNew.", version: 4, expectedPolicyRevision: REVISION };

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  routes = {};
  requests = [];
});

describe("automatic approval of agent changes", () => {
  it("requests review after a section write when the caller is eligible", async () => {
    routes = {
      "PATCH /api/mcp/specifications/s1/section": { status: 200, body: { change: { id: "c1" }, spec: draft } },
      "GET /api/mcp/products/p1": product(true),
      "POST /api/mcp/specifications/s1/request-review": approved,
    };
    const res = await call("update_specification_section", section);
    expect(res.isError).toBe(false);
    expect(calls()).toEqual([
      "PATCH /api/mcp/specifications/s1/section",
      "GET /api/mcp/products/p1",
      "POST /api/mcp/specifications/s1/request-review",
    ]);
    expect(res.body.autoApproval).toEqual({ applied: true, status: "REVIEWED", approvedVersion: 3, openQuestionsCount: 0 });
    expect(res.body.change).toEqual({ id: "c1" });
    expect(res.body.spec).toMatchObject({ id: "s1", status: "REVIEWED", approvedVersion: 3, version: 4 });
    const review = requests.find((r) => r.key === "POST /api/mcp/specifications/s1/request-review")!;
    expect(review.headers["x-kstonebase-policy-revision"]).toBe(REVISION);
  });

  it("leaves the Draft and the result unchanged when the caller is not eligible", async () => {
    routes = {
      "PATCH /api/mcp/specifications/s1/content": { status: 200, body: { spec: draft } },
      "GET /api/mcp/products/p1": product(false),
    };
    const res = await call("update_specification_content", { specId: "s1", content: "# X", version: 4 });
    expect(calls()).toEqual(["PATCH /api/mcp/specifications/s1/content", "GET /api/mcp/products/p1"]);
    expect(res.body).toEqual({ spec: draft });
  });

  it("treats an older API without the setting as not eligible", async () => {
    routes = {
      "PATCH /api/mcp/specifications/s1/content": { status: 200, body: { spec: draft } },
      "GET /api/mcp/products/p1": { status: 200, body: { id: "p1" } },
    };
    const res = await call("update_specification_content", { specId: "s1", content: "# X", version: 4 });
    expect(res.body).toEqual({ spec: draft });
  });

  it("opens a draft on a Reviewed target, sends the write once more and requests review", async () => {
    routes = {
      "PATCH /api/mcp/specifications/s1/section": [locked, { status: 200, body: { change: { id: "c1" }, spec: draft } }],
      "GET /api/mcp/specifications/s1": { status: 200, body: { ...draft, status: "REVIEWED" } },
      "GET /api/mcp/products/p1": product(true),
      "POST /api/mcp/specifications/s1/start-new-version": { status: 200, body: { spec: draft } },
      "POST /api/mcp/specifications/s1/request-review": approved,
    };
    const res = await call("update_specification_section", section);
    expect(res.isError).toBe(false);
    expect(calls()).toEqual([
      "PATCH /api/mcp/specifications/s1/section",
      "GET /api/mcp/specifications/s1",
      "GET /api/mcp/products/p1",
      "POST /api/mcp/specifications/s1/start-new-version",
      "PATCH /api/mcp/specifications/s1/section",
      "GET /api/mcp/products/p1",
      "POST /api/mcp/specifications/s1/request-review",
    ]);
    expect(res.body.autoApproval.applied).toBe(true);
  });

  it("keeps the SPEC_LOCKED refusal when the caller is not eligible", async () => {
    routes = {
      "PATCH /api/mcp/specifications/s1/section": locked,
      "GET /api/mcp/specifications/s1": { status: 200, body: { ...draft, status: "REVIEWED" } },
      "GET /api/mcp/products/p1": product(false),
    };
    const res = await call("update_specification_section", section);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("SPEC_LOCKED");
    expect(calls()).not.toContain("POST /api/mcp/specifications/s1/start-new-version");
  });

  it("reports a failed request for review without failing the write", async () => {
    routes = {
      "POST /api/mcp/products/p1/specifications": { status: 201, body: { spec: { ...draft, approvedVersion: 1 } } },
      "GET /api/mcp/products/p1": product(true),
      "POST /api/mcp/specifications/s1/request-review": {
        status: 422,
        body: { error: { code: "VALIDATION_ERROR", message: "Coverage incomplete.", details: { code: "REVIEW_COVERAGE_INCOMPLETE" } } },
      },
    };
    const res = await call("create_free_specification", { productId: "p1", title: "X", content: "# X" });
    expect(res.isError).toBe(false);
    expect(res.body.autoApproval).toMatchObject({ applied: false, status: "DRAFT", reason: "REQUEST_REVIEW_FAILED" });
    expect(res.body.autoApproval.error.code).toBe("REVIEW_COVERAGE_INCOMPLETE");
  });

  it("approves the indexes a create added in the same call", async () => {
    routes = {
      "POST /api/mcp/products/p1/specifications": {
        status: 201,
        body: {
          spec: {
            ...draft,
            indexEffects: [
              { action: "created", specificationId: "i1", status: "DRAFT" },
              { action: "reused", specificationId: "i0", status: "REVIEWED" },
            ],
          },
        },
      },
      "GET /api/mcp/products/p1": product(true),
      "POST /api/mcp/specifications/s1/request-review": approved,
      "POST /api/mcp/specifications/i1/request-review": approved,
    };
    const res = await call("create_free_specification", { productId: "p1", title: "X", content: "# X" });
    expect(calls()).not.toContain("POST /api/mcp/specifications/i0/request-review");
    expect(res.body.autoApproval.indexes.map((i: { specificationId: string }) => i.specificationId)).toEqual(["i1"]);
  });

  it("requests review for the Drafts an applied Product plan wrote", async () => {
    routes = {
      "POST /api/mcp/authoring-plans/apply": {
        status: 200,
        body: {
          applied: true,
          replayed: false,
          results: [
            { action: "create", specificationId: "a", status: "DRAFT" },
            { action: "update", specificationId: "b", status: "DRAFT" },
            { action: "reuse_index", specificationId: "c", status: "REVIEWED" },
          ],
        },
      },
      "GET /api/mcp/products/p1": product(true),
      "POST /api/mcp/specifications/a/request-review": approved,
      "POST /api/mcp/specifications/b/request-review": approved,
    };
    const res = await call("apply_authoring_plan", {
      container: { type: "product", id: "p1" },
      authoringRevision: "ar1_AuthoringRevision00000",
      subjects: [{ key: "billing", title: "Billing", folder: "billing" }],
      operations: [{ action: "create", subject: "billing", path: "billing/invoices.md", title: "Invoices", content: "# Invoices" }],
      planDigest: `ap1_${"D".repeat(43)}`,
      idempotencyKey: "plan-key-0001",
    });
    expect(res.isError).toBe(false);
    expect(res.body.autoApproval.results.map((r: { specificationId: string; applied: boolean }) => [r.specificationId, r.applied])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });
});
