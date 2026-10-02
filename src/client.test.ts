import { describe, expect, it, vi } from "vitest";

import { KstonebaseClient } from "./client.js";
import { McpToolError } from "./errors.js";

interface MockResponseInit {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  textBody?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const text =
    init.textBody !== undefined
      ? init.textBody
      : init.body !== undefined
        ? JSON.stringify(init.body)
        : "";
  const headers = new Headers(init.headers ?? {});
  // 304 / 204 etc. forbid a body in the spec, so build a minimal
  // Response-shaped object directly rather than going through the web
  // constructor (which throws for null-body statuses).
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    text: async () => text,
  } as unknown as Response;
}

describe("KstonebaseClient — auth header", () => {
  it("attaches Authorization: Bearer on every call", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://app.example.com",
      token: "kstonebase_pat_TESTTOKEN",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listProducts();
    expect(fetcher).toHaveBeenCalledOnce();
    const [, init] = fetcher.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer kstonebase_pat_TESTTOKEN");
  });

  it("strips trailing slashes on the base URL", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://app.example.com//",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listProducts();
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://app.example.com/api/mcp/products",
    );
  });
});

describe("KstonebaseClient — list_specifications query encoding", () => {
  it("repeats the tag param for each tag", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    await client.listSpecifications("ws_1", { tags: ["a", "b"] });
    const url = fetcher.mock.calls[0][0] as string;
    expect(url).toContain("tag=a");
    expect(url).toContain("tag=b");
  });
});

describe("KstonebaseClient — etag handling", () => {
  it("forwards If-None-Match and surfaces a 304 NotModified", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const ifNoneMatch = (init?.headers as Record<string, string>)[
        "if-none-match"
      ];
      if (ifNoneMatch === 'W/"v5-raw"') {
        return mockResponse({ status: 304, headers: { etag: 'W/"v5-raw"' } });
      }
      return mockResponse({ body: { content: "...", etag: 'W/"v5-raw"' } });
    });
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const res = await client.readSpecification("spec_1", {
      ifNoneMatch: 'W/"v5-raw"',
    });
    expect(res).toEqual({ notModified: true, etag: 'W/"v5-raw"', status: 304 });
  });

  it("returns the etag header on 200 responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        body: { content: "x" },
        headers: { etag: 'W/"v5-raw"' },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const res = await client.readSpecification("spec_1");
    expect("etag" in res ? res.etag : null).toBe('W/"v5-raw"');
  });
});

describe("KstonebaseClient — error mapping", () => {
  it("maps an API 401 to AUTH_FAILED", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        status: 401,
        body: { error: { code: "UNAUTHORIZED", message: "no auth" } },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const err = await client.listProducts().catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe("AUTH_FAILED");
  });

  it("maps PRODUCT_TYPE_MISMATCH from the body's details.code", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({
        status: 400,
        body: {
          error: {
            message: "Type doesn't fit",
            details: { code: "PRODUCT_TYPE_MISMATCH" },
          },
        },
      }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const err = await client
      .listSpecifications("ws_1", { type: "BUSINESS" })
      .catch((e) => e);
    expect((err as McpToolError).code).toBe("PRODUCT_TYPE_MISMATCH");
  });
});

describe("KstonebaseClient — checkAuth", () => {
  it("returns the product count on success", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [{ id: "ws_a" }, { id: "ws_b" }] } }),
    );
    const client = new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
    const probe = await client.checkAuth();
    expect(probe).toEqual({ ok: true, products: 2 });
  });
});

describe("KstonebaseClient — change history", () => {
  function client(fetcher: ReturnType<typeof vi.fn>) {
    return new KstonebaseClient({
      apiUrl: "https://x.example",
      token: "t",
      fetcher: fetcher as unknown as typeof fetch,
    });
  }

  it("lists change entries for a spec", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { items: [{ changeId: "c1" }] } }),
    );
    await client(fetcher).listSpecificationChanges("spec_1");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://x.example/api/mcp/specifications/spec_1/changes",
    );
  });

  it("reads one change entry and honours If-None-Match", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const ifNoneMatch = (init?.headers as Record<string, string>)[
        "if-none-match"
      ];
      if (ifNoneMatch === '"c1"') {
        return mockResponse({ status: 304, headers: { etag: '"c1"' } });
      }
      return mockResponse({ body: { changeId: "c1", content: "the note" } });
    });
    const c = client(fetcher);

    const fresh = await c.readSpecificationChange("spec_1", "c1");
    expect(fetcher.mock.calls[0][0]).toBe(
      "https://x.example/api/mcp/specifications/spec_1/changes/c1",
    );
    expect(fresh).toMatchObject({ body: { content: "the note" } });

    const cached = await c.readSpecificationChange("spec_1", "c1", '"c1"');
    expect(cached).toMatchObject({ notModified: true, etag: '"c1"' });
  });

  it("omits version from append_context when the caller doesn't pass one", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { change: { id: "c1" } } }),
    );
    await client(fetcher).appendContext("spec_1", { content: "a note" });
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({ content: "a note" });
  });

  it("passes changeNote through on section writes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      mockResponse({ body: { spec: { id: "spec_1" } } }),
    );
    await client(fetcher).updateSpecificationSection("spec_1", {
      sectionPath: "## Pricing",
      newSection: "## Pricing\nnew",
      version: 3,
      changeNote: "tightened the wording",
    });
    const [, init] = fetcher.mock.calls[0];
    expect(JSON.parse(init?.body as string).changeNote).toBe(
      "tightened the wording",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Open-question CRUD (Kstonebase MCP spec "mcp-open-question-management" §4,
// implementation contract §1–§4). Fixtures are the contract's canonical ones.
// ──────────────────────────────────────────────────────────────────────────

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
  spec: {
    id: "s_1",
    version: 13,
    approvedVersion: 2,
    status: "DRAFT",
    openQuestionsCount: 1,
  },
};

const DELETE_FIXTURE = {
  deletedQuestionId: "q_1",
  spec: {
    id: "s_1",
    version: 15,
    approvedVersion: 2,
    status: "DRAFT",
    openQuestionsCount: 0,
  },
};

describe("KstonebaseClient — open questions", () => {
  const TOKEN = "kstonebase_pat_OQTEST";

  function setup(response: MockResponseInit = { body: QUESTION_FIXTURE }) {
    const fetcher = vi.fn<typeof fetch>(async () => mockResponse(response));
    const client = new KstonebaseClient({
      apiUrl: "https://kstonebase.example",
      token: TOKEN,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const call = (i = 0) => {
      const [url, init] = fetcher.mock.calls[i];
      return {
        url: url as string,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        rawBody: init?.body as string | undefined,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        initKeys: Object.keys(init ?? {}),
      };
    };
    return { fetcher, client, call };
  }

  it("reads one item with GET on the encoded item path", async () => {
    const { client, call } = setup();
    const res = await client.readOpenQuestion("s_1", "q_1");
    expect(call().method).toBe("GET");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/s_1/open-questions/q_1",
    );
    expect(call().rawBody).toBeUndefined();
    expect(res.body).toEqual(QUESTION_FIXTURE);
    expect(res.status).toBe(200);
  });

  it("percent-encodes both ids", async () => {
    const { client, call } = setup();
    await client.readOpenQuestion("spec/1 ?x", "q#1&a=b/..");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/spec%2F1%20%3Fx/open-questions/q%231%26a%3Db%2F..",
    );
  });

  it("rejects empty, '.' and '..' ids before sending anything", async () => {
    const { fetcher, client } = setup();
    for (const [specId, questionId] of [
      ["", "q_1"],
      ["s_1", ""],
      [".", "q_1"],
      ["s_1", ".."],
    ]) {
      const err = await client
        .deleteOpenQuestion(specId, questionId, {
          version: 1,
          expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(McpToolError);
      expect((err as McpToolError).code).toBe("VALIDATION_ERROR");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("creates with POST, sends only the keys that were given, and returns the 201 body", async () => {
    const { client, call } = setup({ status: 201, body: QUESTION_FIXTURE });
    const res = await client.createOpenQuestion("s_1", {
      version: 12,
      body: "Who approves refunds?",
    });
    expect(call().method).toBe("POST");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/s_1/open-questions",
    );
    expect(call().headers["content-type"]).toBe("application/json");
    expect(call().rawBody).toBe('{"version":12,"body":"Who approves refunds?"}');
    expect(res.status).toBe(201);
    expect(res.body).toEqual(QUESTION_FIXTURE);
  });

  it("create keeps kind and an explicit null sectionPath", async () => {
    const { client, call } = setup({ status: 201, body: QUESTION_FIXTURE });
    await client.createOpenQuestion("s_1", {
      version: 12,
      body: "Refunds are approved by finance",
      kind: "ASSUMPTION",
      sectionPath: null,
    });
    expect(call().body).toEqual({
      version: 12,
      body: "Refunds are approved by finance",
      kind: "ASSUMPTION",
      sectionPath: null,
    });
  });

  it("create sends a sectionPath string unchanged", async () => {
    const { client, call } = setup({ status: 201, body: QUESTION_FIXTURE });
    await client.createOpenQuestion("s_1", {
      version: 12,
      body: "Who approves refunds?",
      sectionPath: "## Refunds",
    });
    expect(call().body).toEqual({
      version: 12,
      body: "Who approves refunds?",
      sectionPath: "## Refunds",
    });
  });

  it("updates with PATCH, keeping explicit nulls and omitting undefined keys", async () => {
    const { client, call } = setup();
    await client.updateOpenQuestion("s_1", "q_1", {
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
      sectionPath: null,
      answer: null,
      body: undefined,
      status: undefined,
    });
    expect(call().method).toBe("PATCH");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/s_1/open-questions/q_1",
    );
    expect(call().rawBody).toBe(
      '{"version":13,"expectedUpdatedAt":"2026-09-26T18:04:05.123Z","sectionPath":null,"answer":null}',
    );
  });

  it("update forwards body, answer and status as given", async () => {
    const { client, call } = setup();
    await client.updateOpenQuestion("s_1", "q_1", {
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
      body: "Who approves refunds over 100 EUR?",
      answer: "Finance",
      status: "RESOLVED",
    });
    expect(call().body).toEqual({
      version: 13,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
      body: "Who approves refunds over 100 EUR?",
      answer: "Finance",
      status: "RESOLVED",
    });
  });

  it("deletes with a JSON body and parses the JSON 200 result", async () => {
    const { client, call } = setup({ status: 200, body: DELETE_FIXTURE });
    const res = await client.deleteOpenQuestion("s_1", "q_1", {
      version: 14,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
    });
    expect(call().method).toBe("DELETE");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/s_1/open-questions/q_1",
    );
    expect(call().headers["content-type"]).toBe("application/json");
    expect(call().body).toEqual({
      version: 14,
      expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
    });
    expect(res.body).toEqual(DELETE_FIXTURE);
  });

  it("round-trips both conflict tokens without coercion", async () => {
    // Go drops trailing zeros ("…05.1Z"); a Date round-trip would turn it
    // into "…05.100Z" and the API would answer STALE_QUESTION.
    const { client, call } = setup();
    for (const expectedUpdatedAt of [
      "2026-09-26T18:04:05.1Z",
      "2026-09-26T18:04:05Z",
      "2026-09-26T18:04:05.123456Z",
    ]) {
      await client.updateOpenQuestion("s_1", "q_1", {
        version: 2147483647,
        expectedUpdatedAt,
        status: "DISMISSED",
      });
    }
    await client.deleteOpenQuestion("s_1", "q_1", {
      version: 9007199254740991,
      expectedUpdatedAt: "2026-09-26T18:04:05.1Z",
    });
    expect(call(0).rawBody).toContain('"expectedUpdatedAt":"2026-09-26T18:04:05.1Z"');
    expect(call(1).rawBody).toContain('"expectedUpdatedAt":"2026-09-26T18:04:05Z"');
    expect(call(2).rawBody).toContain('"expectedUpdatedAt":"2026-09-26T18:04:05.123456Z"');
    expect(call(0).rawBody).toContain('"version":2147483647');
    expect(call(3).rawBody).toBe(
      '{"version":9007199254740991,"expectedUpdatedAt":"2026-09-26T18:04:05.1Z"}',
    );
  });

  it("sends only the Bearer token as a credential", async () => {
    const { client, call, fetcher } = setup();
    await client.readOpenQuestion("s_1", "q_1");
    await client.createOpenQuestion("s_1", { version: 1, body: "b" });
    await client.updateOpenQuestion("s_1", "q_1", {
      version: 1,
      expectedUpdatedAt: "t",
      status: "OPEN",
    });
    await client.deleteOpenQuestion("s_1", "q_1", {
      version: 1,
      expectedUpdatedAt: "t",
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 4; i += 1) {
      const { headers, initKeys } = call(i);
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(
        Object.keys(headers).every((h) =>
          ["authorization", "accept", "content-type"].includes(h),
        ),
      ).toBe(true);
      expect(initKeys.every((k) => ["method", "headers", "body"].includes(k))).toBe(true);
    }
  });

  it("adds X-Kstonebase-Policy-Revision only when a policy revision is passed (never in the body)", async () => {
    const { client, call, fetcher } = setup();
    const revision = "wp1_AbCdEfGhIjKlMnOpQrStUv";
    await client.createOpenQuestion("s_1", { version: 1, body: "b" }, { policyRevision: revision });
    await client.updateOpenQuestion(
      "s_1",
      "q_1",
      { version: 1, expectedUpdatedAt: "t", status: "OPEN" },
      { policyRevision: revision },
    );
    await client.deleteOpenQuestion("s_1", "q_1", { version: 1, expectedUpdatedAt: "t" }, { policyRevision: revision });
    await client.startNewVersion("s_1", { policyRevision: revision });
    await client.createOpenQuestion("s_1", { version: 1, body: "b" });
    await client.createOpenQuestion("s_1", { version: 1, body: "b" }, {});
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 4; i += 1) {
      const { headers, rawBody } = call(i);
      expect(headers["x-kstonebase-policy-revision"]).toBe(revision);
      expect(
        Object.keys(headers).every((h) =>
          ["authorization", "accept", "content-type", "x-kstonebase-policy-revision"].includes(h),
        ),
      ).toBe(true);
      expect(rawBody ?? "").not.toContain(revision);
    }
    // start_new_version has no body, so no content-type either.
    expect(call(3).headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      accept: "application/json",
      "x-kstonebase-policy-revision": revision,
    });
    for (const i of [4, 5]) expect(call(i).headers).not.toHaveProperty("x-kstonebase-policy-revision");
  });

  it("surfaces STALE_QUESTION with its hint and does not retry", async () => {
    const { client, fetcher } = setup({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "The question changed since you read it.",
          details: {
            code: "STALE_QUESTION",
            hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
          },
        },
      },
    });
    const err = await client
      .updateOpenQuestion("s_1", "q_1", {
        version: 13,
        expectedUpdatedAt: "2026-09-26T18:04:05.123Z",
        status: "RESOLVED",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe("STALE_QUESTION");
    expect((err as McpToolError).details?.hint).toContain("read_open_question");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a mutation whose request failed in flight", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new KstonebaseClient({
      apiUrl: "https://kstonebase.example",
      token: TOKEN,
      fetcher: fetcher as unknown as typeof fetch,
    });
    await expect(
      client.createOpenQuestion("s_1", { version: 12, body: "b" }),
    ).rejects.toThrow("fetch failed");
    await expect(
      client.deleteOpenQuestion("s_1", "q_1", { version: 1, expectedUpdatedAt: "t" }),
    ).rejects.toThrow("fetch failed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps list_open_questions on the same path and passes the additive fields through", async () => {
    const listBody = {
      items: [QUESTION_FIXTURE.question],
      spec: QUESTION_FIXTURE.spec,
    };
    const { client, call } = setup({ body: listBody });
    const res = await client.listOpenQuestions("s_1", { includeResolved: true });
    expect(call().method).toBe("GET");
    expect(call().url).toBe(
      "https://kstonebase.example/api/mcp/specifications/s_1/open-questions?includeResolved=true",
    );
    expect(res.body).toEqual(listBody);
    expect(res.body.spec?.version).toBe(13);
    expect(res.body.items[0].resolvedAt).toBeNull();
  });
});

describe("KstonebaseClient — effective Workspace instructions", () => {
  const TOKEN = "kstonebase_pat_POLICYTEST";

  function setup(responses: MockResponseInit[]) {
    const fetcher = vi.fn<typeof fetch>(async () => mockResponse(responses.shift()));
    const client = new KstonebaseClient({
      apiUrl: "https://kstonebase.example",
      token: TOKEN,
      fetcher: fetcher as unknown as typeof fetch,
    });
    return { fetcher, client };
  }

  it("GETs /api/mcp/agent-policy with one target per parameter and instructions=omit on request", async () => {
    const body = { items: [] };
    const { client, fetcher } = setup([{ body }, { body }]);
    const res = await client.getAgentPolicy([
      { type: "workspace", id: "ws_1" },
      { type: "specification", id: "s:1/x" },
    ]);
    expect(res.body).toEqual(body);
    await client.getAgentPolicy([{ type: "product", id: "p_1" }], { omitInstructions: true });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://kstonebase.example/api/mcp/agent-policy?target=workspace%3Aws_1&target=specification%3As%3A1%2Fx",
      "https://kstonebase.example/api/mcp/agent-policy?target=product%3Ap_1&instructions=omit",
    ]);
    const [, init] = fetcher.mock.calls[0];
    expect(init).toEqual({
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}`, accept: "application/json" },
    });
  });

  it("throws POLICY_UNSUPPORTED for a 404 without an error code or a non-JSON body", async () => {
    for (const response of [
      { status: 404, textBody: "<!doctype html><title>404</title>" },
      { status: 404, textBody: "" },
      { status: 404, body: { result: false, message: "Not Found" } },
      { status: 200, textBody: "<html></html>" },
    ]) {
      const { client } = setup([response]);
      const err = await client.getAgentPolicy([{ type: "workspace", id: "ws_1" }]).catch((e) => e);
      expect(err).toBeInstanceOf(McpToolError);
      expect((err as McpToolError).code).toBe("POLICY_UNSUPPORTED");
      expect((err as McpToolError).message).toBe("This Kstonebase server does not provide Workspace instructions.");
    }
  });

  it("maps every other failure as usual", async () => {
    const { client } = setup([
      { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } },
      { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "bad", details: { code: "INVALID_TARGET" } } } },
      { status: 502, textBody: "<html>Bad gateway</html>" },
    ]);
    const codes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const err = await client.getAgentPolicy([{ type: "workspace", id: "ws_1" }]).catch((e) => e);
      codes.push((err as McpToolError).code);
    }
    expect(codes).toEqual(["NOT_FOUND", "VALIDATION_ERROR", "INTERNAL_ERROR"]);
  });
});
