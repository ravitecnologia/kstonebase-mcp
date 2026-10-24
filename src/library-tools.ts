// Workspace Library tools of the standalone package (Kstonebase MCP ›
// features/mcp-library-tools.md, PBI 352; API › features/workspace-library.md
// §9; Business › epics/workspace-library.md §4.6 and §4.9).
//
// Names, titles, descriptions, annotations and input schemas come from
// ./library-catalog, the file the Kstonebase-hosted and Desktop registry
// shares. Results are the API bodies, passed through, plus a guidance text
// item where the spec asks for one. list_library, read_library_file and
// read_library_file_content carry the Workspace instructions notice of the
// file's Workspace; the link and access-request tools return only the link
// or status (their API answers name no Workspace).
//
// Safety rules (spec §1):
// - The package never fetches a returned link: not a temporary link, not a
//   one-time `/library/redeem/` link, not an approval URL. Links are only
//   handed to the model, never logged.
// - read_library_file_content reads the file's metadata first and calls the
//   content route only for a common image or audio file of up to 10 MB, so
//   it never asks the API for the bytes of a secret file. The API refuses
//   such a request anyway: annotations and these checks are never
//   authorization.
// - Library tools are Workspace-scoped: a Product-only binding gets "not
//   found or outside this credential's scope" before any request.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { KstonebaseClient, McpLibraryFile } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { McpToolError } from "./errors.js";
import {
  LIBRARY_CONTENT_MAX_BYTES,
  LIBRARY_ERROR_TEXT,
  LIBRARY_INPUT_SCHEMAS,
  LIBRARY_TOOLS,
  libraryAccessText,
  libraryLinkText,
  libraryRequestText,
  type LibraryErrorCode,
  type LibraryToolName,
} from "./library-catalog.js";
import type { PolicyNotices } from "./policy.js";
import { createToolRunner, ok, type ToolBody, type ToolCall, type ToolResult } from "./tools.js";

interface LibraryToolDeps {
  client: KstonebaseClient;
  config: ResolvedConfig;
  policy: PolicyNotices;
}

type Args = Record<string, unknown>;

function libraryError(code: LibraryErrorCode | "NOT_FOUND"): McpToolError {
  const text = LIBRARY_ERROR_TEXT[code];
  return new McpToolError(code, text.message, text.remediation);
}

/**
 * list_library's Workspace: the explicit `workspaceId`, else the bound one.
 * A Product-only binding never selects a Workspace and sees no Library, so
 * it gets the spec's not-found answer without any request.
 */
export function resolveLibraryWorkspaceId(config: ResolvedConfig, explicit: unknown): string {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (config.workspaceId) return config.workspaceId;
  if (config.productId) throw libraryError("NOT_FOUND");
  throw new McpToolError(
    "WORKSPACE_NOT_BOUND",
    "The Library belongs to a Workspace, and none is bound to this MCP session.",
    "Pass workspaceId, or call list_workspaces, pick the Workspace, then add it to .kstonebase.json as `workspaceId` or set KSTONEBASE_WORKSPACE_ID. The credential must cover the whole Workspace.",
  );
}

/** The notice of the file's Workspace, when the API named it. */
function addressFileWorkspace(call: ToolCall, file: { workspaceId?: unknown } | null | undefined): void {
  if (file && typeof file.workspaceId === "string" && file.workspaceId.length > 0) {
    call.addresses({ type: "workspace", id: file.workspaceId });
  }
}

function withText(result: ToolResult, text: string): ToolResult {
  result.content.push({ type: "text", text });
  return result;
}

/**
 * read_library_file_content: metadata first; the content route only for a
 * common image or audio file of up to 10 MB. Anything else is refused here,
 * before any byte is requested.
 */
async function readContent(
  client: KstonebaseClient,
  call: ToolCall,
  fileId: string,
): Promise<ToolResult> {
  const meta = (await client.readLibraryFile(fileId)).body as McpLibraryFile | null;
  // Fail closed: anything but an explicit `common` is treated as secret.
  if (meta?.exposure !== "common") throw libraryError("LIBRARY_APPROVAL_REQUIRED");
  const mediaKind = meta.kind === "image" || meta.kind === "audio";
  if (!mediaKind || typeof meta.size !== "number" || meta.size > LIBRARY_CONTENT_MAX_BYTES) {
    throw libraryError("LIBRARY_CONTENT_TOO_LARGE");
  }
  const content = (await client.readLibraryFileContent(fileId)).body;
  const contentType = typeof content?.contentType === "string" ? content.contentType : "";
  const blockType = contentType.startsWith("image/")
    ? "image"
    : contentType.startsWith("audio/")
      ? "audio"
      : undefined;
  if (!blockType || typeof content?.base64 !== "string") {
    throw libraryError("LIBRARY_CONTENT_TOO_LARGE");
  }
  addressFileWorkspace(call, meta);
  const summary = {
    fileId: content.fileId ?? meta.id,
    workspaceId: meta.workspaceId,
    name: content.name ?? meta.name,
    kind: meta.kind,
    contentType,
    size: content.size ?? meta.size,
    exposure: meta.exposure,
    folderPath: meta.folderPath,
  };
  const result: ToolResult = {
    content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    structuredContent: summary,
  };
  // The SDK accepts image and audio blocks; ToolResult types only text.
  (result.content as unknown[]).push({ type: blockType, data: content.base64, mimeType: contentType });
  return result;
}

/** The body of each tool. */
function toolBody(name: LibraryToolName, args: Args, deps: LibraryToolDeps): ToolBody {
  const { client, config } = deps;
  const fileId = args.fileId as string;
  switch (name) {
    case "list_library":
      return async (call) => {
        const workspaceId = resolveLibraryWorkspaceId(config, args.workspaceId);
        call.addresses({ type: "workspace", id: workspaceId });
        const res = await client.listLibrary(workspaceId, {
          folderId: args.folderId as string | undefined,
          cursor: args.cursor as string | undefined,
          limit: args.limit as number | undefined,
        });
        return ok(res.body);
      };
    case "read_library_file":
      return async (call) => {
        const res = await client.readLibraryFile(fileId);
        addressFileWorkspace(call, res.body);
        return ok(res.body);
      };
    case "get_library_file_link":
      return async () => {
        const res = await client.getLibraryFileLink(fileId);
        return withText(ok(res.body), libraryLinkText(res.body ?? {}));
      };
    case "read_library_file_content":
      return (call) => readContent(client, call, fileId);
    case "request_library_file_access":
      return async () => {
        const res = await client.requestLibraryFileAccess(fileId, { purpose: args.purpose as string });
        return withText(ok(res.body), libraryRequestText(res.body ?? {}));
      };
    case "read_library_file_access":
      return async () => {
        const res = await client.readLibraryFileAccess(args.requestId as string);
        const body = { ...(res.body ?? {}) } as Record<string, unknown>;
        // The one-time link is handed over only for an approved request.
        if (body.status !== "approved") delete body.url;
        return withText(ok(body), libraryAccessText(body));
      };
  }
}

export function registerLibraryTools(server: McpServer, deps: LibraryToolDeps): void {
  const runTool = createToolRunner(deps.policy);
  for (const tool of LIBRARY_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: LIBRARY_INPUT_SCHEMAS[tool.name](),
      },
      async (args: Args) =>
        runTool(
          tool.name,
          // Ids only: links, purposes and contents are never logged.
          {
            workspaceId: args.workspaceId,
            folderId: args.folderId,
            fileId: args.fileId,
            requestId: args.requestId,
          },
          toolBody(tool.name, args, deps),
        ),
    );
  }
}
