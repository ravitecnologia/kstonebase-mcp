import { describe, expect, it } from "vitest";

import { McpToolError, boardRemediation, mapApiError, type ApiErrorBody } from "./errors.js";

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

describe("mapApiError — PRODUCT_TYPE_UNSUPPORTED (PBI 271)", () => {
  it("tells the agent to omit the management type, since new Products always use the flexible document model", () => {
    const err = mapApiError(400, envelope("PRODUCT_TYPE_UNSUPPORTED", "New Products always use the flexible document model."));
    expect(err.code).toBe("PRODUCT_TYPE_UNSUPPORTED");
    expect(err.remediation).toBe(
      "New Products always use the flexible document model. Omit specificationManagementType.",
    );
  });

  it("reads PRODUCT_TYPE_UNSUPPORTED from details.code under BAD_REQUEST (was INTERNAL_ERROR) and keeps the API hint", () => {
    const err = mapApiError(
      400,
      envelope("BAD_REQUEST", "New Products always use the flexible document model.", {
        code: "PRODUCT_TYPE_UNSUPPORTED",
        requested: "web_application",
        supported: ["free"],
        hint: "Omit specificationManagementType; new Products always use the flexible document model.",
      }),
    );
    expect(err.code).toBe("PRODUCT_TYPE_UNSUPPORTED");
    expect(err.message).toBe("New Products always use the flexible document model.");
    expect(err.remediation).toBe(
      "New Products always use the flexible document model. Omit specificationManagementType.",
    );
    // `requested` and `supported` travel since the authoring contract's
    // detail allowlist (MCP › specification-authoring/protocol.md T5).
    expect(err.details).toEqual({
      requested: "web_application",
      supported: ["free"],
      hint: "Omit specificationManagementType; new Products always use the flexible document model.",
    });
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

describe("mapApiError — board-import mode (MCP › mcp-board-tools.md §2.2)", () => {
  it("maps IMPORT_NOT_FOUND from details.code in both Board modes, never in the default mode", () => {
    for (const mode of ["board", "board-import"] as const) {
      const err = mapApiError(404, envelope("NOT_FOUND", "m", { code: "IMPORT_NOT_FOUND" }), mode);
      expect(err.code).toBe("IMPORT_NOT_FOUND");
      expect(err.remediation).toContain("list_board_imports");
      expect(err.remediation).toContain("Workspace Settings → General → Azure DevOps");
      expect(err.remediation).toContain("Import from Azure DevOps");
    }
    expect(mapApiError(404, envelope("NOT_FOUND", "m", { code: "IMPORT_NOT_FOUND" })).code).toBe("NOT_FOUND");
  });

  it("words OWNER_REQUIRED, INVALID_CURSOR, VALIDATION_ERROR and INTERNAL_ERROR for the report reads only", () => {
    const owner = (mode: "board" | "board-import") =>
      mapApiError(403, envelope("FORBIDDEN", "m", { code: "OWNER_REQUIRED" }), mode).remediation;
    expect(owner("board-import")).toContain("import reports are visible to the Workspace Owner only");
    expect(owner("board-import")).toContain("list_board_items and read_board_item");
    expect(owner("board")).toContain("archive or restore");
    expect(owner("board")).not.toContain("import");

    const cursor = mapApiError(400, envelope("BAD_REQUEST", "m", { code: "INVALID_CURSOR", field: "cursor" }), "board-import");
    expect(cursor.code).toBe("INVALID_CURSOR");
    expect(cursor.details).toEqual({ field: "cursor" });
    expect(cursor.remediation).toContain("plan and outcome");

    const invalid = mapApiError(
      400,
      envelope("BAD_REQUEST", "m", { code: "VALIDATION_ERROR", field: "outcome", problem: "invalid-value" }),
      "board-import",
    );
    expect(invalid.details).toEqual({ field: "outcome", problem: "invalid-value" });
    expect(invalid.remediation).toContain("pending, imported, already_imported, skipped, blocked, failed");

    const internal = mapApiError(500, envelope("INTERNAL_ERROR", "INTERNAL_ERROR"), "board-import");
    expect(internal.code).toBe("INTERNAL_ERROR");
    expect(internal.remediation).toContain("retry the read once");
    expect(internal.remediation).not.toContain("idempotencyKey");
  });

  it("keeps every other Board remediation and the Board detail allowlist", () => {
    const scope = mapApiError(403, envelope("FORBIDDEN", "W", { code: "WORKSPACE_SCOPE_REQUIRED", hint: "h", token: "x" }), "board-import");
    expect(scope.code).toBe("WORKSPACE_SCOPE_REQUIRED");
    expect(scope.remediation).toContain("whole-Workspace credential");
    expect(scope.details).toEqual({ hint: "h" });
    const missing = mapApiError(404, envelope("NOT_FOUND", "m", { code: "NOT_FOUND" }), "board-import");
    expect(missing.remediation).toContain("Owner or a current Member");
    expect(boardRemediation("BOARD_UNAVAILABLE", "board-import")).toBe(boardRemediation("BOARD_UNAVAILABLE"));
  });

  it("explains a code-less 404/405/501 as missing import report routes", () => {
    for (const status of [404, 405, 501]) {
      const err = mapApiError(status, { error: { message: "API returned a non-JSON payload." } }, "board-import");
      expect(err.remediation).toContain("does not serve the Board import report tools");
      expect(err.remediation).toContain("list_board_items and read_board_item");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Specification authoring (MCP › specification-authoring/protocol.md "Frozen
// client contract (v1)" T5, PBI 276). The remediation sentences are kept
// here as independent literals so any drift in src/errors.ts fails.
// ──────────────────────────────────────────────────────────────────────────

const AUTHORING_REMEDIATIONS: Record<string, string> = {
  BODY_HISTORY_VIOLATION:
    "Keep the body as consolidated current state: remove the dated change log or history section from the content and record those decisions with append_context or a changeNote. The findings name each line.",
  REVIEW_COVERAGE_INCOMPLETE:
    'Cover each listed rubric dimension with substantive text, an explicit "Not applicable: <reason>" line or a native open question or assumption, then request review again.',
  CONTENT_TOO_LARGE:
    "Split the subject into smaller, focused specifications linked from its folder index (limit 512 KiB).",
  INVALID_CONTENT: "Remove U+0000 (NUL) characters from the title, path, tags and content, then retry.",
  INVALID_PATH:
    'Use a relative path without "." or ".." segments, control characters or an index.md folder segment, with at most 16 segments of 200 bytes; details.rule and details.hint name the problem.',
  PATH_CONFLICT:
    "A specification already exists at this path (details.existingId): update or reuse it, or choose another path.",
  PATH_CASE_CONFLICT:
    "The path differs from an existing path only by letter case (details.existingPath): reuse the existing spelling.",
  INDEX_CONFLICT:
    "Another change created this folder index at the same time: retry, and the existing index will be reused.",
  INDEX_REQUIRED:
    "This folder index is required by the active specifications in details.dependents: archive, delete or move them first, or keep the index.",
  SPEC_NOT_ARCHIVED: "Only an archived specification can be restored; this one is already active, so read it again.",
  AUTHORING_REVISION_REQUIRED: "Pass the authoringRevision from read_authoring_context or from the prepared plan.",
  AUTHORING_REVISION_STALE:
    "The Product's authoring settings or ancestor indexes changed (details.currentRevision): call read_authoring_context again, re-read the indexes and prepare a new plan.",
  AUTHORING_PLAN_STALE:
    "Something the plan depends on changed and nothing was applied: re-read the affected specifications, prepare and validate the plan again, then apply it with a new idempotencyKey.",
  AUTHORING_PLAN_INVALID:
    "The plan has blocking findings and nothing was applied: fix the operations named in details.findings, validate again, then apply.",
  IDEMPOTENCY_KEY_CONFLICT:
    "This idempotencyKey was already used for a different request: use a new key for a new plan, or resend the exact original request to read its outcome.",
  AUTHORING_UNAVAILABLE:
    "Authoring plans are not enabled on this server: create or update one specification at a time with the single-specification tools.",
  INVALID_PLAN_REQUEST:
    "The plan request has the wrong shape (details.field, details.rule): correct that field and send the request again.",
  PAYLOAD_TOO_LARGE: "The request is too large: split the plan into smaller plans (at most 4 MiB).",
  CONTAINER_ARCHIVED: "The Product or Workspace is archived: restore it before changing its specifications.",
  INVALID_TARGET: "Pass exactly one target: a workspaceId, productId or specificationId.",
  AUTHORING_UNSUPPORTED:
    "This Kstonebase server does not support authoring context or plans yet. Use the single-specification tools and tell the user the authoring rules could not be checked.",
};

describe("mapApiError — specification authoring codes (T5)", () => {
  // [status, envelope code, details.code] as the API's /mcp routes send them.
  const cases: Array<[number, string, string]> = [
    [422, "VALIDATION_ERROR", "BODY_HISTORY_VIOLATION"],
    [422, "VALIDATION_ERROR", "REVIEW_COVERAGE_INCOMPLETE"],
    [422, "VALIDATION_ERROR", "CONTENT_TOO_LARGE"],
    [422, "VALIDATION_ERROR", "INVALID_CONTENT"],
    [422, "VALIDATION_ERROR", "INVALID_PATH"],
    [409, "CONFLICT", "PATH_CONFLICT"],
    [409, "CONFLICT", "PATH_CASE_CONFLICT"],
    [409, "CONFLICT", "INDEX_CONFLICT"],
    [409, "CONFLICT", "INDEX_REQUIRED"],
    [409, "SPEC_NOT_ARCHIVED", "SPEC_NOT_ARCHIVED"],
    [428, "PRECONDITION_REQUIRED", "AUTHORING_REVISION_REQUIRED"],
    [409, "CONFLICT", "AUTHORING_REVISION_STALE"],
    [409, "CONFLICT", "AUTHORING_PLAN_STALE"],
    [422, "VALIDATION_ERROR", "AUTHORING_PLAN_INVALID"],
    [409, "CONFLICT", "IDEMPOTENCY_KEY_CONFLICT"],
    [404, "NOT_FOUND", "AUTHORING_UNAVAILABLE"],
    [422, "VALIDATION_ERROR", "INVALID_PLAN_REQUEST"],
    [409, "CONFLICT", "CONTAINER_ARCHIVED"],
    [422, "VALIDATION_ERROR", "INVALID_TARGET"],
  ];

  for (const [status, envelopeCode, detailCode] of cases) {
    it(`${status} ${envelopeCode} + ${detailCode} → ${detailCode} (default and authoring modes)`, () => {
      for (const mode of ["default", "authoring"] as const) {
        const err = mapApiError(status, envelope(envelopeCode, "Refused.", { code: detailCode, hint: "API hint." }), mode);
        expect(err.code, mode).toBe(detailCode);
        expect(err.message).toBe("Refused.");
        expect(err.remediation).toBe(AUTHORING_REMEDIATIONS[detailCode]);
        // The API's own hint travels unchanged next to the sentence.
        expect(err.details).toEqual({ hint: "API hint." });
      }
    });
  }

  it("PATH_CONFLICT on a single-spec write is PATH_CONFLICT, no longer the 409's STALE_VERSION", () => {
    const err = mapApiError(
      409,
      envelope("CONFLICT", "A specification already exists at that path.", {
        code: "PATH_CONFLICT",
        path: "billing/invoices.md",
        existingId: "s_9",
        hint: "Update the existing specification, or choose another path.",
      }),
    );
    expect(err.code).toBe("PATH_CONFLICT");
    expect(err.details).toEqual({
      path: "billing/invoices.md",
      existingId: "s_9",
      hint: "Update the existing specification, or choose another path.",
    });
  });

  it("413 is PAYLOAD_TOO_LARGE with or without an envelope; the API's `limit` is not an allowlisted detail", () => {
    const api = mapApiError(
      413,
      envelope("PAYLOAD_TOO_LARGE", "The authoring plan request is larger than 4 MiB.", { code: "BODY_TOO_LARGE", limit: 4194304 }),
      "authoring",
    );
    expect(api.code).toBe("PAYLOAD_TOO_LARGE");
    expect(api.remediation).toBe(AUTHORING_REMEDIATIONS.PAYLOAD_TOO_LARGE);
    expect(api.details).toBeUndefined();
    const proxy = mapApiError(413, { error: { message: "API returned a non-JSON payload." } }, "authoring");
    expect(proxy.code).toBe("PAYLOAD_TOO_LARGE");
    expect(mapApiError(413, null).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("authoring mode: 404, 405 or 501 without the API error envelope is AUTHORING_UNSUPPORTED", () => {
    const bodies: Array<[number, ApiErrorBody | null]> = [
      [404, { error: { message: "API returned a non-JSON payload." } }],
      [404, null],
      [404, { result: false, message: "Not Found" } as unknown as ApiErrorBody],
      [405, null],
      [501, { error: { message: "API returned a non-JSON payload." } }],
    ];
    for (const [status, body] of bodies) {
      const err = mapApiError(status, body, "authoring");
      expect(err.code, String(status)).toBe("AUTHORING_UNSUPPORTED");
      expect(err.message).toBe("This Kstonebase server does not provide authoring context or plans.");
      expect(err.remediation).toBe(AUTHORING_REMEDIATIONS.AUTHORING_UNSUPPORTED);
      expect(err.details).toBeUndefined();
    }
    // With the envelope it is the API's own answer.
    expect(mapApiError(404, envelope("NOT_FOUND", "Product not found."), "authoring").code).toBe("NOT_FOUND");
    // Other modes keep their mapping.
    expect(mapApiError(404, null).code).toBe("NOT_FOUND");
    expect(mapApiError(501, null).code).toBe("INTERNAL_ERROR");
  });

  it("keeps only the allowlisted details, at most 50 findings with their listed keys and 5 dependents, strings clipped to 2,000", () => {
    const finding = (i: number) => ({
      ruleId: "DATED_CHANGE_LOG",
      severity: "error",
      message: `Line ${i} records history.`,
      operation: 0,
      path: "billing/invoices.md",
      subject: "billing",
      location: { line: i, heading: "## History", column: 3 },
      excerpt: "2026-01-01: changed",
      dimension: "history",
      remediation: "Move it to append_context.",
      secret: "dropped",
    });
    const details = {
      code: "AUTHORING_PLAN_INVALID",
      findings: Array.from({ length: 60 }, (_, i) => finding(i + 1)),
      total: 60,
      truncated: true,
      truncatedFindings: true,
      remediation: "r".repeat(2_500),
      dependents: Array.from({ length: 8 }, (_, i) => ({ id: `s_${i}`, path: `a/${i}.md`, title: "dropped" })),
      dependentCount: 8,
      folder: "a",
      digest: `ap1_${"x".repeat(43)}`,
      currentRevision: "ar1_AuthoringRevision00002",
      item: { id: "dropped" },
      content: "never passed on",
    };
    const err = mapApiError(422, envelope("VALIDATION_ERROR", "The plan has blocking findings.", details), "authoring");
    expect(err.code).toBe("AUTHORING_PLAN_INVALID");
    const out = err.details as Record<string, any>;
    expect(Object.keys(out).sort()).toEqual(
      ["currentRevision", "dependentCount", "dependents", "digest", "findings", "folder", "remediation", "total", "truncated", "truncatedFindings"].sort(),
    );
    expect(out.findings).toHaveLength(50);
    expect(out.findings[0]).toEqual({
      ruleId: "DATED_CHANGE_LOG",
      severity: "error",
      message: "Line 1 records history.",
      operation: 0,
      path: "billing/invoices.md",
      subject: "billing",
      location: { line: 1, heading: "## History" },
      excerpt: "2026-01-01: changed",
      dimension: "history",
      remediation: "Move it to append_context.",
    });
    expect(out.dependents).toEqual(Array.from({ length: 5 }, (_, i) => ({ id: `s_${i}`, path: `a/${i}.md` })));
    expect(out.remediation).toBe("r".repeat(2_000));
    expect(out.total).toBe(60);
    expect(out.truncated).toBe(true);
  });

  it("clips long finding texts by code point and drops malformed findings and dependents", () => {
    const long = "😀".repeat(2_100);
    const err = mapApiError(
      409,
      envelope("CONFLICT", "Required.", {
        code: "INDEX_REQUIRED",
        findings: ["not an object", { message: long, location: "line 3" }],
        dependents: [null, { id: "s_1", path: long }],
      }),
    );
    const out = err.details as Record<string, any>;
    expect(out.findings).toEqual([{ message: "😀".repeat(2_000) }]);
    expect(out.dependents).toEqual([{ id: "s_1", path: "😀".repeat(2_000) }]);
  });

  it("the shared codes keep their existing details and gain the authoring ones", () => {
    const locked = mapApiError(
      409,
      envelope("SPEC_LOCKED", "Specification is not editable in its current status.", {
        code: "SPEC_LOCKED",
        status: "REVIEWED",
        hint: "call start_new_version first",
        fields: ["content"],
      }),
    );
    expect(locked.code).toBe("SPEC_LOCKED");
    expect(locked.details).toEqual({ status: "REVIEWED", hint: "call start_new_version first", fields: ["content"] });
    // Other codes keep the existing allowlist only.
    const stale = mapApiError(409, envelope("CONFLICT", "Stale.", { code: "STALE_VERSION", path: "x.md", hint: "re-read" }));
    expect(stale.details).toEqual({ hint: "re-read" });
  });
});
