// Tool registration for the MCP server (per Kstonebase spec "mcp-server" §6
// "Tool naming"). The stdio and --http transports both build their server
// through buildServer(), so every tool registered here is advertised with
// the same name, schema and annotations on each.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import {
  McpToolError,
  buildClientFailure,
  type McpFailure,
} from "./errors.js";
import { logger } from "./logger.js";
import { runInitProduct, runInitWorkspace } from "./setup-tool.js";

interface ToolDeps {
  client: KstonebaseClient;
  config: ResolvedConfig;
}

const READ_TOOL: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const ADDITIVE_WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};

const OVERWRITE_WRITE_TOOL: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

// Open-question tool descriptions (Kstonebase MCP spec
// "mcp-open-question-management", implementation contract §6). The contract
// pins this exact text for the Website registry as well, so every transport
// tells the agent the same thing; change both together.
const READ_OPEN_QUESTION_DESCRIPTION =
  "Read one open question or assumption on a Specification, together with the Specification's current version. Read-only. Returns the item's updatedAt, which update_open_question and delete_open_question need as expectedUpdatedAt.";

const CREATE_OPEN_QUESTION_DESCRIPTION =
  'Add an open question (kind QUESTION, the default) or an assumption (kind ASSUMPTION) to a Draft Specification. The record and its inline marker are written together: <open_question>BODY</open_question> or _Assumption: BODY_ at the end of the section named by sectionPath (a heading such as "## Scope"), or at the end of the document when sectionPath is omitted. Requires the Specification\'s current version and advances it.';

const UPDATE_OPEN_QUESTION_DESCRIPTION =
  "Edit, move, resolve, dismiss or reopen an open question or assumption on a Draft Specification. The record and the Markdown change together: resolving a question replaces its marker with the answer (an answer is required); dismissing a question keeps its marker; resolving an assumption turns it into plain prose; dismissing an assumption strikes it through as not valid; reopening restores an unresolved marker and keeps earlier decision prose. Body, sectionPath and answer change only while the item is OPEN. Requires version and expectedUpdatedAt from your latest read; after STALE_VERSION or STALE_QUESTION, re-read before retrying.";

const DELETE_OPEN_QUESTION_DESCRIPTION =
  "Permanently delete an open question or assumption from a Draft Specification. Removes the record and any marker still in the document; prose written by an earlier resolution or dismissal stays. This cannot be undone: to set an item aside, use update_open_question with status DISMISSED instead. Requires version and expectedUpdatedAt from your latest read.";

/**
 * Resolves the effective product id — explicit argument wins, then the
 * config's `productId` (file or env). Throws PRODUCT_NOT_BOUND when
 * neither is present.
 */
function requireProductId(
  config: ResolvedConfig,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (config.productId) return config.productId;
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product is bound to this MCP session.",
    "Call list_products, pick one, then add it to .kstonebase.json or set KSTONEBASE_PRODUCT_ID.",
  );
}

/**
 * Phase 4: Workspace counterpart. Throws WORKSPACE_NOT_BOUND when the
 * binding doesn't include a Workspace id.
 */
function requireWorkspaceId(
  config: ResolvedConfig,
  explicit: string | undefined,
): string {
  if (explicit && explicit.length > 0) return explicit;
  if (config.workspaceId) return config.workspaceId;
  throw new McpToolError(
    "WORKSPACE_NOT_BOUND",
    "No workspace is bound to this MCP session.",
    "Call list_workspaces, pick one, then add it to .kstonebase.json as `workspaceId` or set KSTONEBASE_WORKSPACE_ID.",
  );
}

interface ListTargetArgs {
  scope?: "workspace" | "product";
  productId?: string;
  workspaceId?: string;
}

/**
 * Phase 4 default-scope resolution for `list_specifications`:
 *   * Both binding ids set                → Product's specs
 *   * workspaceId only                    → Workspace's own specs
 *   * productId only                      → Product's specs
 *   * Explicit `scope` arg                → honoured (with the matching id
 *                                            from args or the binding)
 */
function resolveListSpecificationsTarget(
  config: ResolvedConfig,
  args: ListTargetArgs,
): { scope: "workspace" | "product"; id: string } {
  // Explicit scope wins — but the corresponding id must resolve.
  if (args.scope === "workspace") {
    return { scope: "workspace", id: requireWorkspaceId(config, args.workspaceId) };
  }
  if (args.scope === "product") {
    return { scope: "product", id: requireProductId(config, args.productId) };
  }
  // Explicit ids without a scope arg also win.
  if (args.productId) {
    return { scope: "product", id: args.productId };
  }
  if (args.workspaceId) {
    return { scope: "workspace", id: args.workspaceId };
  }
  // Fall back to the binding-mode default per spec §3.
  if (config.productId) return { scope: "product", id: config.productId };
  if (config.workspaceId)
    return { scope: "workspace", id: config.workspaceId };
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product or workspace is bound to this MCP session.",
    "Call list_products or list_workspaces to discover ids, then bind in .kstonebase.json.",
  );
}

/**
 * Search defaults to the Workspace cross-scope endpoint when bound to a
 * Workspace; that endpoint searches both Workspace specs and every member
 * Product. With only a Product binding it falls through to the
 * Product-scoped search.
 */
function resolveSearchSpecificationsTarget(
  config: ResolvedConfig,
  args: ListTargetArgs,
): { scope: "workspace" | "product"; id: string } {
  if (args.scope === "workspace") {
    return { scope: "workspace", id: requireWorkspaceId(config, args.workspaceId) };
  }
  if (args.scope === "product") {
    return { scope: "product", id: requireProductId(config, args.productId) };
  }
  if (args.workspaceId) {
    return { scope: "workspace", id: args.workspaceId };
  }
  if (args.productId) {
    return { scope: "product", id: args.productId };
  }
  if (config.workspaceId) {
    return { scope: "workspace", id: config.workspaceId };
  }
  if (config.productId) {
    return { scope: "product", id: config.productId };
  }
  throw new McpToolError(
    "PRODUCT_NOT_BOUND",
    "No product or workspace is bound to this MCP session.",
    "Call list_products or list_workspaces to discover ids, then bind in .kstonebase.json.",
  );
}

// CallToolResult-shaped envelopes. The SDK's typings expect an open-ended
// record with a string index signature, so we use Record<string, unknown>
// rather than a closed interface.
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} & Record<string, unknown>;

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent:
      typeof data === "object" && data !== null
        ? (data as Record<string, unknown>)
        : { value: data },
  };
}

function fail(failure: McpFailure): ToolResult {
  let text = `${failure.code}: ${failure.message}\n\n${failure.remediation}`;
  if (failure.details) {
    // The API's hint / reason / fields / status / sectionPath / from / to,
    // so the agent can decide what to re-read without guessing.
    text += `\n\nDetails: ${JSON.stringify(failure.details)}`;
  }
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: failure as unknown as Record<string, unknown>,
  };
}

/**
 * Wrap an async tool body so any thrown McpToolError translates to a
 * structured tool failure. Anything else maps to INTERNAL_ERROR — agents
 * can decide whether to retry. Tool calls also emit a debug log line
 * matching the spec's `tool / productId / specId / durationMs / errorCode`
 * shape.
 */
async function runTool(
  name: string,
  context: Record<string, unknown>,
  body: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const startedAt = Date.now();
  try {
    const result = await body();
    logger.debug("tool", {
      tool: name,
      durationMs: Date.now() - startedAt,
      ...context,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof McpToolError) {
      logger.warn("tool failed", {
        tool: name,
        durationMs,
        errorCode: err.code,
        ...context,
      });
      return fail(err.toFailure());
    }
    logger.error("tool crashed", {
      tool: name,
      durationMs,
      errorCode: "INTERNAL_ERROR",
      err: (err as Error).message,
      ...context,
    });
    return fail(
      buildClientFailure(
        "INTERNAL_ERROR",
        (err as Error).message ?? "Unexpected MCP server error.",
      ),
    );
  }
}

export function registerReadTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, config } = deps;

  server.registerTool(
    "list_products",
    {
      title: "List products",
      description:
        "List Products visible to this token. With a Workspace binding, returns the Workspace's member Products; without, returns orphan Products (Products not attached to any Workspace). Read-only. Use this to discover a productId to bind.",
      annotations: READ_TOOL,
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async (args) =>
      runTool("list_products", { workspaceId: args.workspaceId }, async () => {
        // Default: when bound to a Workspace, list its member Products.
        // Otherwise list orphan Products so the agent can pick one to bind.
        const explicit = args.workspaceId;
        const wsId = explicit ?? config.workspaceId ?? undefined;
        const res = await client.listProducts(
          wsId ? { workspaceId: wsId } : { orphan: true },
        );
        return ok(res.body);
      }),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List Workspaces visible to this token. Read-only. Use this when discovering which Workspace to bind in .kstonebase.json.",
      annotations: READ_TOOL,
      inputSchema: {},
    },
    async () =>
      runTool("list_workspaces", {}, async () => {
        const res = await client.listWorkspaces();
        return ok(res.body);
      }),
  );

  server.registerTool(
    "read_product",
    {
      title: "Read a product",
      description:
        "Read a Product's metadata: name, description, specificationManagementType, and member-of Workspace (when set). Read-only.",
      annotations: READ_TOOL,
      inputSchema: {
        productId: z.string().optional(),
      },
    },
    async (args) =>
      runTool("read_product", { productId: args.productId }, async () => {
        const productId = requireProductId(config, args.productId);
        const res = await client.readProduct(productId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "read_workspace",
    {
      title: "Read a workspace",
      description:
        "Read a Workspace's metadata: name, description, specificationManagementType, archived state. Read-only.",
      annotations: READ_TOOL,
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "read_workspace",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.readWorkspace(wsId);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "list_specifications",
    {
      title: "List specifications",
      description:
        "List specifications in scope. Read-only. Default scope follows the binding: when both workspaceId and productId are bound, lists the Product's specs; with only workspaceId, lists the Workspace's own specs; with only productId, lists the Product's specs. Pass `scope` and/or `productId`/`workspaceId` to override. Filters are type-aware: Free scopes accept folder/tag; Web Application Products accept the BUSINESS/UX/DESIGN_SYSTEM type filter.",
      annotations: READ_TOOL,
      inputSchema: {
        scope: z.enum(["workspace", "product"]).optional(),
        productId: z.string().optional(),
        workspaceId: z.string().optional(),
        type: z
          .enum(["BUSINESS", "UX", "DESIGN_SYSTEM", "DOCUMENT"])
          .optional(),
        status: z
          .enum(["DRAFT", "GENERATING", "NEEDS_REVIEW", "REVIEWED"])
          .optional(),
        folder: z.string().optional(),
        tags: z.array(z.string()).optional(),
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) =>
      runTool(
        "list_specifications",
        {
          scope: args.scope,
          productId: args.productId,
          workspaceId: args.workspaceId,
        },
        async () => {
          const target = resolveListSpecificationsTarget(config, args);
          const query = {
            type: args.type,
            status: args.status,
            folder: args.folder,
            tags: args.tags,
            query: args.query,
            cursor: args.cursor,
            limit: args.limit,
          };
          const res =
            target.scope === "workspace"
              ? await client.listSpecificationsForWorkspace(target.id, query)
              : await client.listSpecifications(target.id, query);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "search_specifications",
    {
      title: "Search specifications",
      description:
        "Lexical full-text search across spec titles and content. Read-only. With a Workspace binding, searches both the Workspace's specs and every member Product; results carry a `scope` discriminator. With only a Product binding, searches that Product's specs.",
      annotations: READ_TOOL,
      inputSchema: {
        scope: z.enum(["workspace", "product"]).optional(),
        productId: z.string().optional(),
        workspaceId: z.string().optional(),
        query: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
        includeArchived: z.boolean().optional(),
      },
    },
    async (args) =>
      runTool(
        "search_specifications",
        {
          scope: args.scope,
          productId: args.productId,
          workspaceId: args.workspaceId,
        },
        async () => {
          const target = resolveSearchSpecificationsTarget(config, args);
          const query = {
            query: args.query,
            limit: args.limit,
            includeArchived: args.includeArchived,
          };
          const res =
            target.scope === "workspace"
              ? await client.searchSpecificationsForWorkspace(target.id, query)
              : await client.searchSpecifications(target.id, query);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "read_specification",
    {
      title: "Read a specification",
      description:
        'Read the current Markdown content of a specification. Read-only. Returns the document plus status and version. Use format="rendered" when the agent should ignore open-question and assumption markers.',
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        format: z.enum(["raw", "rendered"]).optional(),
      },
    },
    async (args) =>
      runTool("read_specification", { specId: args.specId }, async () => {
        const res = await client.readSpecification(args.specId, {
          format: args.format,
        });
        if ("notModified" in res) {
          // Not reachable from a tool call (no If-None-Match passed) but
          // typed exhaustively for safety.
          return ok({ notModified: true, etag: res.etag });
        }
        return ok(res.body);
      }),
  );

  server.registerTool(
    "list_specification_versions",
    {
      title: "List approved versions",
      description:
        "List the approved (user-marked Reviewed) snapshots for a specification, newest first. Read-only.",
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "list_specification_versions",
        { specId: args.specId },
        async () => {
          const res = await client.listSpecificationVersions(args.specId);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "read_specification_version",
    {
      title: "Read an approved version",
      description:
        "Read the full Markdown of a specific approved revision. Read-only. Use this with list_specification_versions to compare past wording with current content.",
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        revisionId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "read_specification_version",
        { specId: args.specId },
        async () => {
          const res = await client.readSpecificationVersion(
            args.specId,
            args.revisionId,
          );
          if ("notModified" in res) {
            return ok({ notModified: true, etag: res.etag });
          }
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "list_specification_changes",
    {
      title: "List change entries",
      description:
        "List the change entries recorded against a specification, newest first. Read-only. These are the decisions and fixes behind the spec, kept out of the document so the spec body reads as one consolidated statement — use this to recover the 'why'. Distinct from list_specification_versions, which returns whole-document snapshots.",
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "list_specification_changes",
        { specId: args.specId },
        async () => {
          const res = await client.listSpecificationChanges(args.specId);
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "read_specification_change",
    {
      title: "Read a change entry",
      description:
        "Read the full Markdown of one change entry. Read-only. Pair with list_specification_changes to trace why a spec says what it says.",
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        changeId: z.string().min(1),
      },
    },
    async (args) =>
      runTool(
        "read_specification_change",
        { specId: args.specId },
        async () => {
          const res = await client.readSpecificationChange(
            args.specId,
            args.changeId,
          );
          if ("notModified" in res) {
            return ok({ notModified: true, etag: res.etag });
          }
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "list_open_questions",
    {
      title: "List open questions",
      description:
        "List the questions and assumptions attached to a specification. Read-only. Resolved or dismissed items are excluded by default; pass includeResolved=true to surface the full set.",
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        includeResolved: z.boolean().optional(),
      },
    },
    async (args) =>
      runTool("list_open_questions", { specId: args.specId }, async () => {
        const res = await client.listOpenQuestions(args.specId, {
          includeResolved: args.includeResolved,
        });
        return ok(res.body);
      }),
  );

  server.registerTool(
    "read_open_question",
    {
      title: "Read an open question",
      description: READ_OPEN_QUESTION_DESCRIPTION,
      annotations: READ_TOOL,
      inputSchema: {
        specId: z.string(),
        questionId: z.string(),
      },
    },
    async (args) =>
      runTool(
        "read_open_question",
        { specId: args.specId, questionId: args.questionId },
        async () => {
          const res = await client.readOpenQuestion(
            args.specId,
            args.questionId,
          );
          return ok(res.body);
        },
      ),
  );

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer read tool (per Kstonebase MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "find_product_by_subject",
    {
      title: "Find products by subject",
      description:
        "Search for Products in the bound Workspace by a free-text subject. Read-only. Returns candidates ranked by a lexical score across name, tags, and description. Use this when the agent needs to choose which Product is about a given topic; the calling agent is expected to do its own semantic reranking.",
      annotations: READ_TOOL,
      inputSchema: {
        workspaceId: z.string().optional(),
        subject: z.string().min(1).max(200),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (args) =>
      runTool(
        "find_product_by_subject",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.findProductBySubject(wsId, {
            subject: args.subject,
            limit: args.limit,
          });
          return ok(res.body);
        },
      ),
  );
}

export function registerWriteTools(
  server: McpServer,
  deps: ToolDeps,
): void {
  const { client, config } = deps;

  server.registerTool(
    "start_new_version",
    {
      title: "Start a new draft",
      description:
        "Open a new draft of a Reviewed specification. Side effect: status becomes Draft. Does not bump the user-visible version. Required before update_specification_content on a published spec. No-op when the spec is already in Draft (response carries hint=\"already_draft\").",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("start_new_version", { specId: args.specId }, async () => {
        const res = await client.startNewVersion(args.specId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "update_specification_content",
    {
      title: "Replace a draft's full content",
      description:
        "Replace the entire Markdown body of a Draft specification. Side effect: content + OCC version are updated. Pass `version` from the most recent read to detect concurrent edits. Returns 409 STALE_VERSION when another writer landed first — re-read and retry. Pass `changeNote` to record why the content changed; it is stored as a change entry rather than inside the document.",
      annotations: OVERWRITE_WRITE_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        content: z.string().max(1_000_000),
        version: z.number().int().min(1),
        changeNote: z.string().trim().min(1).max(2_000).optional(),
      },
    },
    async (args) =>
      runTool(
        "update_specification_content",
        { specId: args.specId },
        async () => {
          const res = await client.updateSpecificationContent(args.specId, {
            content: args.content,
            version: args.version,
            changeNote: args.changeNote,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "update_specification_section",
    {
      title: "Replace a single section of a draft",
      description:
        'Replace one heading-bound section of a Draft specification (e.g. sectionPath="## Pricing"). Side effect: the section text is replaced atomically, a before-image revision is recorded, and a change entry logs the edit. OCC-guarded — pass `version` from the most recent read. Pass `changeNote` to say why; it becomes the change entry\'s body instead of an auto-generated one.',
      annotations: OVERWRITE_WRITE_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        sectionPath: z.string().trim().min(1).max(200),
        newSection: z.string().max(1_000_000),
        version: z.number().int().min(1),
        changeNote: z.string().trim().min(1).max(2_000).optional(),
      },
    },
    async (args) =>
      runTool(
        "update_specification_section",
        { specId: args.specId },
        async () => {
          const res = await client.updateSpecificationSection(args.specId, {
            sectionPath: args.sectionPath,
            newSection: args.newSection,
            version: args.version,
            changeNote: args.changeNote,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "request_review",
    {
      title: "Request review on a draft",
      description:
        "Move a Draft specification to Needs Review so a human can mark it Reviewed in Kstonebase. Gated on the spec having no open questions — if questions remain, the response returns OPEN_QUESTIONS_PRESENT and the agent should surface them to the user.",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("request_review", { specId: args.specId }, async () => {
        const res = await client.requestReview(args.specId);
        return ok(res.body);
      }),
  );

  server.registerTool(
    "discard_draft",
    {
      title: "Discard the current draft",
      description:
        "Roll a Draft (or Needs Review) specification back to its last approved version. Side effect: content is restored from the latest approved revision and status returns to Reviewed. Rejected when the spec has never been approved.",
      annotations: OVERWRITE_WRITE_TOOL,
      inputSchema: { specId: z.string().min(1) },
    },
    async (args) =>
      runTool("discard_draft", { specId: args.specId }, async () => {
        const res = await client.discardDraft(args.specId);
        return ok(res.body);
      }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Open-question write tools (per Kstonebase MCP spec
  // "mcp-open-question-management"). The API owns the record + Markdown
  // behaviour; these handlers forward the arguments unchanged and never
  // retry — conflicts come back as STALE_* codes for the agent to re-read.
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "create_open_question",
    {
      title: "Create an open question",
      description: CREATE_OPEN_QUESTION_DESCRIPTION,
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        specId: z.string(),
        version: z.number().int(),
        body: z.string(),
        kind: z.enum(["QUESTION", "ASSUMPTION"]).optional(),
        sectionPath: z.string().nullable().optional(),
      },
    },
    async (args) =>
      runTool("create_open_question", { specId: args.specId }, async () => {
        const res = await client.createOpenQuestion(args.specId, {
          version: args.version,
          body: args.body,
          kind: args.kind,
          sectionPath: args.sectionPath,
        });
        return ok(res.body);
      }),
  );

  server.registerTool(
    "update_open_question",
    {
      title: "Update an open question",
      description: UPDATE_OPEN_QUESTION_DESCRIPTION,
      annotations: OVERWRITE_WRITE_TOOL,
      inputSchema: {
        specId: z.string(),
        questionId: z.string(),
        version: z.number().int(),
        expectedUpdatedAt: z.string(),
        body: z.string().optional(),
        sectionPath: z.string().nullable().optional(),
        answer: z.string().nullable().optional(),
        status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).optional(),
      },
    },
    async (args) =>
      runTool(
        "update_open_question",
        { specId: args.specId, questionId: args.questionId },
        async () => {
          const res = await client.updateOpenQuestion(
            args.specId,
            args.questionId,
            {
              version: args.version,
              expectedUpdatedAt: args.expectedUpdatedAt,
              body: args.body,
              sectionPath: args.sectionPath,
              answer: args.answer,
              status: args.status,
            },
          );
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "delete_open_question",
    {
      title: "Delete an open question",
      description: DELETE_OPEN_QUESTION_DESCRIPTION,
      annotations: OVERWRITE_WRITE_TOOL,
      inputSchema: {
        specId: z.string(),
        questionId: z.string(),
        version: z.number().int(),
        expectedUpdatedAt: z.string(),
      },
    },
    async (args) =>
      runTool(
        "delete_open_question",
        { specId: args.specId, questionId: args.questionId },
        async () => {
          const res = await client.deleteOpenQuestion(
            args.specId,
            args.questionId,
            {
              version: args.version,
              expectedUpdatedAt: args.expectedUpdatedAt,
            },
          );
          return ok(res.body);
        },
      ),
  );

  // ────────────────────────────────────────────────────────────────────
  // Knowledge-layer write tools (per Kstonebase MCP spec
  // "mcp-knowledge-layer-tools").
  // ────────────────────────────────────────────────────────────────────

  server.registerTool(
    "create_product",
    {
      title: "Create a Product in the bound Workspace",
      description:
        'Create a new Product inside the bound Workspace. Side effect: a new Product row is created with specificationManagementType="free" by default. Requires a Workspace-scope binding; product-allowlist credentials cannot create Products.',
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        workspaceId: z.string().optional(),
        name: z.string().trim().min(1).max(80),
        description: z.string().max(280).optional(),
        tags: z.array(z.string().min(1).max(40)).max(32).optional(),
        specificationManagementType: z
          .enum(["free", "web_application"])
          .optional(),
      },
    },
    async (args) =>
      runTool(
        "create_product",
        { workspaceId: args.workspaceId },
        async () => {
          const wsId = requireWorkspaceId(config, args.workspaceId);
          const res = await client.createProduct(wsId, {
            name: args.name,
            description: args.description,
            tags: args.tags,
            specificationManagementType: args.specificationManagementType,
          });
          return ok(res.body);
        },
      ),
  );

  server.registerTool(
    "append_context",
    {
      title: "Record a decision or note against a spec",
      description:
        "Record a decision or note against a specification as an immutable change entry. Side effect: one change entry is created and linked to the spec. The specification's own content is NOT modified, so this works on any non-archived spec and needs no start_new_version. Use update_specification_section when the consolidated document itself should change. Read the entries back with list_specification_changes.",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        specId: z.string().min(1),
        content: z.string().min(1).max(1_000_000),
        sectionTitle: z.string().trim().min(1).max(100).optional(),
        // Kept for backward compatibility with older callers; the API ignores
        // it because the document is never touched.
        version: z.number().int().min(1).optional(),
      },
    },
    async (args) =>
      runTool("append_context", { specId: args.specId }, async () => {
        const res = await client.appendContext(args.specId, {
          content: args.content,
          sectionTitle: args.sectionTitle,
          version: args.version,
        });
        return ok(res.body);
      }),
  );

  const setupDeps = () => ({
    client,
    cwd: process.cwd(),
    transport: "stdio" as const,
    boundWorkspaceId: config.workspaceId,
    boundProductId: config.productId,
  });

  server.registerTool(
    "init_workspace",
    {
      title: "Initialise a local Kstonebase workspace binding",
      description:
        "Plan the local files (.kstonebase.json, optionally CLAUDE.md and AGENTS.md) that bind this directory to a Kstonebase Workspace. Returns a structured file plan the agent applies with its own file-write tool. When no workspaceId is supplied and the directory is not already bound, returns status=\"needs_selection\" with the candidate workspaces — present them to the user, then call again with the chosen workspaceId. Idempotent — pass `existingFiles` and `existingKstonebaseJson` so the response carries action=\"skip\" for files already in place, or action=\"conflict\" for a .kstonebase.json that binds different ids. Pass `force=true` to overwrite.",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        workspaceId: z.string().optional(),
        targetDir: z.string().optional(),
        includeAgentDocs: z.boolean().optional(),
        force: z.boolean().optional(),
        existingFiles: z.array(z.string()).optional(),
        existingKstonebaseJson: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "init_workspace",
        { workspaceId: args.workspaceId },
        async () => ok(await runInitWorkspace(args, setupDeps())),
      ),
  );

  server.registerTool(
    "init_product",
    {
      title: "Initialise a local Kstonebase product binding",
      description:
        "Plan the local files (.kstonebase.json, optionally CLAUDE.md and AGENTS.md) that bind this directory to a Kstonebase Product (and its parent Workspace when known). Returns a structured file plan the agent applies with its own file-write tool. When no productId is supplied and the directory is not already bound, returns status=\"needs_selection\" with the candidate products — present them to the user, then call again with the chosen productId (optionally pass a workspaceId to scope the candidate list). Idempotent — pass `existingFiles` and `existingKstonebaseJson` so the response carries action=\"skip\" for files already in place, or action=\"conflict\" for a .kstonebase.json that binds different ids. Pass `force=true` to overwrite.",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        productId: z.string().optional(),
        workspaceId: z.string().optional(),
        targetDir: z.string().optional(),
        includeAgentDocs: z.boolean().optional(),
        force: z.boolean().optional(),
        existingFiles: z.array(z.string()).optional(),
        existingKstonebaseJson: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "init_product",
        { productId: args.productId, workspaceId: args.workspaceId },
        async () => ok(await runInitProduct(args, setupDeps())),
      ),
  );

  // Free-spec creation only makes sense when the bound product is Free.
  // The API enforces this with PRODUCT_TYPE_MISMATCH, but the tool stays
  // listed unconditionally so the agent can call it after binding to a
  // Free product — the type check at call time matches the spec's
  // documented behaviour better than an opaque "tool not found".
  server.registerTool(
    "create_free_specification",
    {
      title: "Create a Free product specification",
      description:
        "Create a new Markdown specification in the bound Free product. Side effect: a new spec row is created at status=Draft, approvedVersion=1. Path uniqueness is enforced. Rejected with PRODUCT_TYPE_MISMATCH when the product is Web Application — use start_new_version on an existing structured spec instead.",
      annotations: ADDITIVE_WRITE_TOOL,
      inputSchema: {
        productId: z.string().optional(),
        title: z.string().min(1).max(200),
        path: z.string().optional(),
        tags: z.array(z.string()).optional(),
        content: z.string().optional(),
      },
    },
    async (args) =>
      runTool(
        "create_free_specification",
        { productId: args.productId },
        async () => {
          const wsId = requireProductId(config, args.productId);
          const res = await client.createFreeSpecification(wsId, {
            title: args.title,
            path: args.path,
            tags: args.tags,
            content: args.content,
          });
          return ok(res.body);
        },
      ),
  );
}
