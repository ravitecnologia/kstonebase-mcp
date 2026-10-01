import { describe, expect, it } from "vitest";

import { McpToolError, mapApiError, type ApiErrorBody } from "./errors.js";

describe("mapApiError — code priority", () => {
  it("maps VALIDATION_ERROR (422) by status when no body code is set", () => {
    const err = mapApiError(422, { error: { message: "bad input" } });
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.code).toBe("VALIDATION_ERROR");
  });

  it("prefers an explicit details.code over the status mapping", () => {
    const err = mapApiError(400, {
      error: {
        message: "Token isn't scoped to ws_b",
        details: { code: "TOKEN_SCOPE_MISMATCH" },
      },
    });
    expect(err.code).toBe("TOKEN_SCOPE_MISMATCH");
  });

  it("maps SPEC_LOCKED via details.code with the documented remediation", () => {
    const err = mapApiError(403, {
      error: {
        message: "Spec is REVIEWED",
        details: { code: "SPEC_LOCKED" },
      },
    });
    expect(err.code).toBe("SPEC_LOCKED");
    expect(err.remediation).toContain("start_new_version");
  });

  it("maps PRODUCT_TYPE_MISMATCH via details.code", () => {
    const err = mapApiError(400, {
      error: {
        message: "Type filter doesn't fit",
        details: { code: "PRODUCT_TYPE_MISMATCH" },
      },
    });
    expect(err.code).toBe("PRODUCT_TYPE_MISMATCH");
  });

  it("falls back to status when no body is provided", () => {
    expect(mapApiError(429, null).code).toBe("RATE_LIMITED");
    expect(mapApiError(401, null).code).toBe("AUTH_FAILED");
    expect(mapApiError(403, null).code).toBe("TOKEN_SCOPE_MISMATCH");
    expect(mapApiError(404, null).code).toBe("NOT_FOUND");
    expect(mapApiError(409, null).code).toBe("STALE_VERSION");
    expect(mapApiError(500, null).code).toBe("INTERNAL_ERROR");
  });

  it("attaches a non-empty remediation to every error", () => {
    const err = mapApiError(404, null);
    expect(err.remediation.length).toBeGreaterThan(10);
  });

  it("converts to a serializable failure shape", () => {
    const failure = mapApiError(401, null).toFailure();
    expect(failure).toEqual(
      expect.objectContaining({
        code: "AUTH_FAILED",
        remediation: expect.any(String),
      }),
    );
  });
});

// Envelopes exactly as the API's /mcp/* routes send them: a generic
// `error.code` plus the specific machine code in `error.details.code`.
function envelope(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

describe("mapApiError — open-question codes (contract §4)", () => {
  const cases: Array<{
    status: number;
    envelopeCode: string;
    details: Record<string, unknown>;
    expected: string;
  }> = [
    {
      status: 409,
      envelopeCode: "CONFLICT",
      details: { code: "STALE_QUESTION", hint: "Re-read the question." },
      expected: "STALE_QUESTION",
    },
    {
      status: 409,
      envelopeCode: "CONFLICT",
      details: { code: "MARKER_NOT_FOUND", hint: "Restore the marker." },
      expected: "MARKER_NOT_FOUND",
    },
    {
      status: 409,
      envelopeCode: "CONFLICT",
      details: { code: "MARKER_AMBIGUOUS", reason: "DUPLICATE_IN_SECTION", hint: "h" },
      expected: "MARKER_AMBIGUOUS",
    },
    {
      status: 404,
      envelopeCode: "NOT_FOUND",
      details: { code: "SECTION_NOT_FOUND", sectionPath: "## Nope" },
      expected: "NOT_FOUND",
    },
    {
      status: 409,
      envelopeCode: "CONFLICT",
      details: { code: "SECTION_NOT_FOUND", reason: "ANCHOR_STALE", hint: "h" },
      expected: "NOT_FOUND",
    },
    {
      status: 409,
      envelopeCode: "CONFLICT",
      details: { code: "SECTION_AMBIGUOUS", sectionPath: "## Scope", hint: "h" },
      expected: "SECTION_AMBIGUOUS",
    },
    {
      status: 422,
      envelopeCode: "VALIDATION_ERROR",
      details: { code: "ANSWER_REQUIRED", fields: ["answer is required to resolve a question"] },
      expected: "ANSWER_REQUIRED",
    },
    {
      status: 400,
      envelopeCode: "BAD_REQUEST",
      details: { code: "INVALID_TRANSITION", from: "RESOLVED", to: "DISMISSED", hint: "h" },
      expected: "INVALID_TRANSITION",
    },
    {
      status: 403,
      envelopeCode: "SPEC_ARCHIVED",
      details: { code: "SPEC_ARCHIVED", hint: "restore the spec first" },
      expected: "SPEC_ARCHIVED",
    },
  ];

  for (const c of cases) {
    it(`maps ${c.envelopeCode}/${String(c.details.code)} (HTTP ${c.status}) to ${c.expected}`, () => {
      const err = mapApiError(c.status, envelope(c.envelopeCode, "msg", c.details));
      expect(err.code).toBe(c.expected);
      expect(err.message).toBe("msg");
      expect(err.remediation.length).toBeGreaterThan(20);
    });
  }

  it("keeps STALE_QUESTION instead of falling through to the 409 STALE_VERSION fallback", () => {
    // Canonical fixture from the contract (§7).
    const err = mapApiError(409, {
      error: {
        code: "CONFLICT",
        message: "The question changed since you read it.",
        details: {
          code: "STALE_QUESTION",
          hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
        },
      },
    });
    expect(err.code).toBe("STALE_QUESTION");
    expect(err.message).toBe("The question changed since you read it.");
    expect(err.remediation).toContain("read_open_question");
    expect(err.details).toEqual({
      hint: "Re-read the question with read_open_question, then retry with its current updatedAt and the specification's current version.",
    });
  });

  it("maps the MARKER_NOT_FOUND fixture and carries its hint", () => {
    const err = mapApiError(409, {
      error: {
        code: "CONFLICT",
        message: "The question's marker is not in the document.",
        details: {
          code: "MARKER_NOT_FOUND",
          hint: "The marker was edited or removed outside this tool. Re-read the specification; restore the marker text or delete the question.",
        },
      },
    });
    expect(err.code).toBe("MARKER_NOT_FOUND");
    expect(err.details?.hint).toContain("restore the marker text");
  });

  it("tells the agent to re-read, not to retry blindly, for every conflict-style code", () => {
    for (const [apiCode, toolCode] of [
      ["STALE_VERSION", "STALE_VERSION"],
      ["STALE_QUESTION", "STALE_QUESTION"],
      ["MARKER_NOT_FOUND", "MARKER_NOT_FOUND"],
      ["MARKER_AMBIGUOUS", "MARKER_AMBIGUOUS"],
      ["SECTION_NOT_FOUND", "NOT_FOUND"],
      ["SECTION_AMBIGUOUS", "SECTION_AMBIGUOUS"],
      ["INVALID_TRANSITION", "INVALID_TRANSITION"],
    ]) {
      const err = mapApiError(409, envelope("CONFLICT", "m", { code: apiCode }));
      expect(err.code).toBe(toolCode);
      expect(err.remediation.toLowerCase()).toContain("re-read");
    }
  });

  it("reports both section misses as NOT_FOUND, told apart by remediation and details", () => {
    // Same tool code as the Website adapter (SECTION_NOT_FOUND → NOT_FOUND).
    const stale = mapApiError(
      409,
      envelope("CONFLICT", "m", { code: "SECTION_NOT_FOUND", reason: "ANCHOR_STALE", hint: "h" }),
    );
    const missing = mapApiError(
      404,
      envelope("NOT_FOUND", "m", { code: "SECTION_NOT_FOUND", sectionPath: "## Nope" }),
    );
    const plain = mapApiError(404, envelope("NOT_FOUND", "Question not found."));
    expect(stale.code).toBe("NOT_FOUND");
    expect(missing.code).toBe("NOT_FOUND");
    expect(stale.remediation).toContain("no longer exists");
    expect(stale.details).toEqual({ reason: "ANCHOR_STALE", hint: "h" });
    expect(missing.remediation).toContain("No heading matches sectionPath");
    expect(missing.details).toEqual({ sectionPath: "## Nope" });
    expect(plain.remediation).not.toBe(missing.remediation);
    expect(plain.remediation).not.toBe(stale.remediation);
    expect(plain.toFailure()).not.toHaveProperty("details");
  });
});

describe("mapApiError — details.code precedence over the envelope", () => {
  it("reads details.code first for specification and question codes", () => {
    // Before 2.2.0 these fell through to the status fallback.
    expect(
      mapApiError(403, envelope("SPEC_ARCHIVED", "Specification is archived.", { code: "SPEC_ARCHIVED", hint: "restore the spec first" })).code,
    ).toBe("SPEC_ARCHIVED");
    expect(
      mapApiError(400, envelope("BAD_REQUEST", "request_review only works on DRAFT specs.", { code: "INVALID_TRANSITION", from: "REVIEWED", to: "NEEDS_REVIEW" })).code,
    ).toBe("INVALID_TRANSITION");
    expect(
      mapApiError(400, envelope("BAD_REQUEST", "Cannot request review while open questions remain.", {
        code: "OPEN_QUESTIONS_PRESENT",
        from: "DRAFT",
        to: "NEEDS_REVIEW",
        openQuestionsCount: 2,
      })).code,
    ).toBe("OPEN_QUESTIONS_PRESENT");
    expect(
      mapApiError(400, envelope("BAD_REQUEST", "m", { code: "PRODUCT_TYPE_MISMATCH", expected: "free", actual: "web_application" })).code,
    ).toBe("PRODUCT_TYPE_MISMATCH");
  });

  it("prefers details.code when both codes are known and differ", () => {
    const err = mapApiError(409, envelope("STALE_VERSION", "m", { code: "STALE_QUESTION" }));
    expect(err.code).toBe("STALE_QUESTION");
  });

  it("falls back to a known envelope code when details.code is unknown", () => {
    const err = mapApiError(403, envelope("SPEC_LOCKED", "m", { code: "SOMETHING_NEW" }));
    expect(err.code).toBe("SPEC_LOCKED");
  });

  it("keeps the existing mapping for the envelopes the API already sends", () => {
    expect(mapApiError(401, envelope("UNAUTHORIZED", "AUTH_REQUIRED", { code: "AUTH_REQUIRED" })).code).toBe("AUTH_FAILED");
    expect(mapApiError(403, envelope("FORBIDDEN", "TOKEN_SCOPE_MISMATCH", { code: "TOKEN_SCOPE_MISMATCH" })).code).toBe("TOKEN_SCOPE_MISMATCH");
    expect(mapApiError(409, envelope("CONFLICT", "m", { code: "STALE_VERSION" })).code).toBe("STALE_VERSION");
    expect(mapApiError(403, envelope("SPEC_LOCKED", "m", { code: "SPEC_LOCKED", status: "REVIEWED" })).code).toBe("SPEC_LOCKED");
    expect(mapApiError(404, envelope("NOT_FOUND", "Question not found.")).code).toBe("NOT_FOUND");
    expect(mapApiError(422, envelope("VALIDATION_ERROR", "m", { fields: ["body is required"] })).code).toBe("VALIDATION_ERROR");
    expect(mapApiError(403, envelope("FORBIDDEN", "FORBIDDEN", { code: "FORBIDDEN" })).code).toBe("TOKEN_SCOPE_MISMATCH");
    expect(mapApiError(500, envelope("INTERNAL_ERROR", "INTERNAL_ERROR")).code).toBe("INTERNAL_ERROR");
    expect(mapApiError(409, envelope("CONFLICT", "m")).code).toBe("STALE_VERSION");
  });

  it("ignores codes that only exist on Object.prototype", () => {
    for (const code of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const err = mapApiError(404, envelope(code, "m", { code }));
      expect(err.code).toBe("NOT_FOUND");
      expect(typeof err.remediation).toBe("string");
    }
  });
});

describe("mapApiError — credential and scope vocabulary is unchanged (spec §6)", () => {
  // What main (2.1.0) returned for the API's credential/scope envelopes.
  // The open-question work must not change these codes at the boundary.
  const unchanged: Array<[string, number, ApiErrorBody, string]> = [
    ["read-only token", 403, envelope("FORBIDDEN", "TOKEN_SCOPE_INSUFFICIENT", { code: "TOKEN_SCOPE_INSUFFICIENT" }), "TOKEN_SCOPE_MISMATCH"],
    ["workspace scope needed", 403, envelope("FORBIDDEN", "WORKSPACE_SCOPE_REQUIRED", { code: "WORKSPACE_SCOPE_REQUIRED", hint: "re-bind this credential at the Workspace level to create Products" }), "TOKEN_SCOPE_MISMATCH"],
    ["outside the allowlist", 403, envelope("FORBIDDEN", "TOKEN_SCOPE_MISMATCH", { code: "TOKEN_SCOPE_MISMATCH" }), "TOKEN_SCOPE_MISMATCH"],
    ["no credential", 401, envelope("UNAUTHORIZED", "AUTH_REQUIRED", { code: "AUTH_REQUIRED" }), "AUTH_FAILED"],
    ["expired under UNAUTHORIZED", 401, envelope("UNAUTHORIZED", "TOKEN_EXPIRED", { code: "TOKEN_EXPIRED" }), "AUTH_FAILED"],
    ["revoked under UNAUTHORIZED", 401, envelope("UNAUTHORIZED", "TOKEN_REVOKED", { code: "TOKEN_REVOKED" }), "AUTH_FAILED"],
    ["expired as envelope code", 401, envelope("TOKEN_EXPIRED", "expired"), "TOKEN_EXPIRED"],
    ["insufficient without envelope code", 403, { error: { message: "m", details: { code: "TOKEN_SCOPE_INSUFFICIENT" } } }, "TOKEN_SCOPE_INSUFFICIENT"],
    ["not in workspace under FORBIDDEN", 403, envelope("FORBIDDEN", "m", { code: "NOT_IN_WORKSPACE" }), "TOKEN_SCOPE_MISMATCH"],
    ["unsupported type under BAD_REQUEST", 400, envelope("BAD_REQUEST", "m", { code: "PRODUCT_TYPE_UNSUPPORTED", requested: "web_application" }), "INTERNAL_ERROR"],
  ];

  for (const [label, status, body, expected] of unchanged) {
    it(`${label} → ${expected}`, () => {
      expect(mapApiError(status, body).code).toBe(expected);
    });
  }

  it("keeps main's message and remediation for a read-only token", () => {
    const failure = mapApiError(
      403,
      envelope("FORBIDDEN", "TOKEN_SCOPE_INSUFFICIENT", { code: "TOKEN_SCOPE_INSUFFICIENT" }),
    ).toFailure();
    expect(failure).toEqual({
      code: "TOKEN_SCOPE_MISMATCH",
      message: "TOKEN_SCOPE_INSUFFICIENT",
      remediation:
        "The token isn't scoped to this product. Use a token whose allowlist includes it, or remove the allowlist.",
    });
  });
});

describe("mapApiError — actionable details", () => {
  it("passes only hint, reason, fields, status, sectionPath, from and to, unchanged", () => {
    const err = mapApiError(
      400,
      envelope("BAD_REQUEST", "m", {
        code: "INVALID_TRANSITION",
        from: "RESOLVED",
        to: "DISMISSED",
        hint: "Reopen it first.",
        internalTrace: "should not leak",
      }),
    );
    expect(err.details).toEqual({
      from: "RESOLVED",
      to: "DISMISSED",
      hint: "Reopen it first.",
    });
    expect(err.toFailure()).toEqual({
      code: "INVALID_TRANSITION",
      message: "m",
      remediation: err.remediation,
      details: { from: "RESOLVED", to: "DISMISSED", hint: "Reopen it first." },
    });
  });

  it("carries validation fields as an array", () => {
    const err = mapApiError(
      422,
      envelope("VALIDATION_ERROR", "Invalid input", {
        code: "ANSWER_REQUIRED",
        fields: ["answer is required to resolve a question"],
      }),
    );
    expect(err.details).toEqual({ fields: ["answer is required to resolve a question"] });
  });

  it("omits details when the API sent none worth passing on", () => {
    expect(mapApiError(404, envelope("NOT_FOUND", "m")).toFailure()).not.toHaveProperty("details");
    expect(mapApiError(401, envelope("UNAUTHORIZED", "AUTH_REQUIRED", { code: "AUTH_REQUIRED" })).toFailure()).not.toHaveProperty("details");
    expect(mapApiError(500, { error: { message: "x", details: ["not", "an", "object"] } }).details).toBeUndefined();
  });
});

describe("mapApiError — SPEC_LOCKED remediation by status", () => {
  function locked(status?: string, hint?: string) {
    return mapApiError(
      403,
      envelope("SPEC_LOCKED", "Specification is not editable in its current status.", {
        code: "SPEC_LOCKED",
        ...(status ? { status } : {}),
        ...(hint ? { hint } : {}),
      }),
    );
  }

  it("REVIEWED → start_new_version", () => {
    const err = locked("REVIEWED", "call start_new_version first");
    expect(err.remediation).toContain("Call start_new_version");
    expect(err.details).toEqual({ status: "REVIEWED", hint: "call start_new_version first" });
  });

  it("NEEDS_REVIEW → a human moves it back to Draft; start_new_version does not unlock it", () => {
    const err = locked("NEEDS_REVIEW", "A human must move it Back to draft.");
    expect(err.remediation).toContain("does not unlock");
    expect(err.remediation).toContain("a human must move it back to Draft");
    expect(err.remediation).not.toMatch(/call start_new_version/i);
    expect(err.details?.hint).toBe("A human must move it Back to draft.");
  });

  it("REVIEWED and NEEDS_REVIEW name the answering and assumption exceptions (contract §11)", () => {
    expect(locked("REVIEWED").remediation).toContain(
      "update_open_question with only the answer and status RESOLVED (a question), or only status RESOLVED or DISMISSED (an assumption), starts a new draft by itself",
    );
    expect(locked("NEEDS_REVIEW").remediation).toContain(
      "update_open_question with only the answer and status RESOLVED (a question), or only status RESOLVED or DISMISSED (an assumption), moves it back to Draft by itself",
    );
    expect(locked().remediation).toContain("Answering an open question or accepting or rejecting an open assumption is the exception");
    expect(locked("GENERATING").remediation).not.toContain("update_open_question");
  });

  it("GENERATING → wait", () => {
    expect(locked("GENERATING").remediation).toContain("Wait for generation to finish");
  });

  it("unknown status → generic text that never claims start_new_version unlocks Needs Review", () => {
    for (const err of [locked(), locked("SOMETHING_ELSE")]) {
      expect(err.remediation).toContain("start_new_version does not unlock Needs Review");
    }
  });
});

describe("McpToolError", () => {
  it("stays compatible with the three-argument constructor", () => {
    const err = new McpToolError("NOT_FOUND", "gone", "check the id");
    expect(err.details).toBeUndefined();
    expect(err.toFailure()).toEqual({
      code: "NOT_FOUND",
      message: "gone",
      remediation: "check the id",
    });
  });
});

describe("mapApiError — board mode (MCP › mcp-board-tools.md §2.1)", () => {
  const BOARD_CODES = [
    "BOARD_UNAVAILABLE",
    "ITEM_NOT_FOUND",
    "WORKSPACE_ARCHIVED",
    "OWNER_REQUIRED",
    "INVALID_PARENT",
    "INVALID_ASSIGNEE",
    "INVALID_PRODUCT",
    "INVALID_CURSOR",
    "IDEMPOTENCY_KEY_REUSED",
    "ACTIVE_CHILDREN",
    "PARENT_ARCHIVED",
    "ITEM_ARCHIVED",
    "ITEM_NOT_ARCHIVED",
    "SPECIFICATION_UNAVAILABLE",
    "SPECIFICATION_ARCHIVED",
    "LINK_LIMIT_REACHED",
    "STALE_VERSION",
    "VALIDATION_ERROR",
    "NOT_FOUND",
  ];

  it("uses details.code as the tool code for every Board code, whatever the envelope", () => {
    for (const code of BOARD_CODES) {
      for (const [status, env] of [[400, "BAD_REQUEST"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [409, "CONFLICT"]] as const) {
        const err = mapApiError(status, envelope(env, "m", { code }), "board");
        expect(err.code, `${env}/${code}`).toBe(code);
        expect(err.remediation.length).toBeGreaterThan(30);
      }
    }
  });

  it("uses details.code for credential refusals too, unlike the default mode", () => {
    const cases: Array<[string, string]> = [
      ["WORKSPACE_SCOPE_REQUIRED", "WORKSPACE_SCOPE_REQUIRED"],
      ["TOKEN_SCOPE_INSUFFICIENT", "TOKEN_SCOPE_INSUFFICIENT"],
      ["TOKEN_SCOPE_MISMATCH", "TOKEN_SCOPE_MISMATCH"],
      ["AUTH_REQUIRED", "AUTH_FAILED"],
    ];
    for (const [code, expected] of cases) {
      const body = envelope(code === "AUTH_REQUIRED" ? "UNAUTHORIZED" : "FORBIDDEN", code, { code });
      const status = code === "AUTH_REQUIRED" ? 401 : 403;
      expect(mapApiError(status, body, "board").code).toBe(expected);
    }
    // The default mode keeps its pinned vocabulary for every other tool.
    expect(
      mapApiError(403, envelope("FORBIDDEN", "WORKSPACE_SCOPE_REQUIRED", { code: "WORKSPACE_SCOPE_REQUIRED" })).code,
    ).toBe("TOKEN_SCOPE_MISMATCH");
    expect(
      mapApiError(403, envelope("FORBIDDEN", "TOKEN_SCOPE_INSUFFICIENT", { code: "TOKEN_SCOPE_INSUFFICIENT" })).code,
    ).toBe("TOKEN_SCOPE_MISMATCH");
  });

  it("passes only field, problem, currentVersion, activeChildren, limit and hint", () => {
    const err = mapApiError(
      409,
      envelope("CONFLICT", "m", {
        code: "STALE_VERSION",
        currentVersion: 7,
        item: { id: "bi_1", implementationPrompt: "do not echo" },
        field: "expectedVersion",
        problem: "stale",
        activeChildren: 2,
        limit: 50,
        hint: "re-read",
        reason: "not on the Board allowlist",
        from: "to_do",
      }),
      "board",
    );
    expect(err.details).toEqual({
      field: "expectedVersion",
      problem: "stale",
      currentVersion: 7,
      activeChildren: 2,
      limit: 50,
      hint: "re-read",
    });
  });

  it("gives STALE_VERSION and WORKSPACE_SCOPE_REQUIRED their Board remediations", () => {
    const stale = mapApiError(409, envelope("CONFLICT", "m", { code: "STALE_VERSION", currentVersion: 3 }), "board");
    expect(stale.remediation).toContain("read_board_item");
    expect(stale.remediation).toContain("Never replay the old request blindly");
    expect(stale.remediation).not.toContain("read_specification");
    const scope = mapApiError(403, envelope("FORBIDDEN", "WORKSPACE_SCOPE_REQUIRED", { code: "WORKSPACE_SCOPE_REQUIRED" }), "board");
    expect(scope.remediation).toContain("whole-Workspace credential");
    expect(scope.remediation).not.toContain("create Products");
  });

  it("explains missing server support when a Board route answers without any code", () => {
    for (const status of [404, 405, 501]) {
      const err = mapApiError(status, { error: { message: "API returned a non-JSON payload." } }, "board");
      expect(err.remediation).toContain("does not serve the native Board tools");
    }
    expect(mapApiError(404, null, "board").code).toBe("NOT_FOUND");
    // A coded NOT_FOUND is an inaccessible Workspace, not an old server.
    expect(mapApiError(404, envelope("NOT_FOUND", "m", { code: "NOT_FOUND" }), "board").remediation).toContain("Owner or a current Member");
  });

  it("falls back sensibly when no code is present", () => {
    expect(mapApiError(400, { error: { message: "m" } }, "board").code).toBe("VALIDATION_ERROR");
    expect(mapApiError(409, envelope("CONFLICT", "m"), "board").code).toBe("STALE_VERSION");
    expect(mapApiError(429, null, "board").code).toBe("RATE_LIMITED");
    expect(mapApiError(500, envelope("INTERNAL_ERROR", "INTERNAL_ERROR"), "board").remediation).toContain("same idempotencyKey");
    for (const code of ["toString", "__proto__"]) {
      expect(mapApiError(404, envelope(code, "m", { code }), "board").code).toBe("NOT_FOUND");
    }
  });
});
