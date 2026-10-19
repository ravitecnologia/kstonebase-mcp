// Workspace Library tool catalog (Kstonebase MCP › features/mcp-library-tools.md
// §2–§3, PBI 352; API › features/workspace-library.md §9; Business ›
// epics/workspace-library.md §4.6 and §4.9).
//
// Names, titles, descriptions, annotations, input schemas, error texts and
// result guidance of the six Library tools. The file depends only on zod and
// the MCP SDK types, so the Kstonebase-hosted and Desktop session registry
// (PBI 351) can copy it verbatim and advertise exactly the same tools.
//
// Rules this catalog encodes:
// - Library tools are Workspace-scoped; a Product-only credential or binding
//   gets "not found or outside this credential's scope".
// - Annotations describe behavior and are never authorization: the API
//   enforces exposure and the human approval of secret files.
// - Links are temporary. The model passes them immediately to the tool that
//   needs the file and never stores them; a one-time link is never fetched
//   through Kstonebase.
// - There are no upload, rename, move, delete, exposure or approve tools.

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/** Largest common image or audio file returned as MCP content (bytes). */
export const LIBRARY_CONTENT_MAX_BYTES = 10_000_000;

/** Largest access-request purpose (characters). */
export const LIBRARY_PURPOSE_MAX_LENGTH = 500;

export type LibraryToolName =
  | "list_library"
  | "read_library_file"
  | "get_library_file_link"
  | "read_library_file_content"
  | "request_library_file_access"
  | "read_library_file_access";

/** list_library and read_library_file: read-only and idempotent. */
const LIBRARY_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** get_library_file_link and read_library_file_content: the file may leave Kstonebase. */
const LIBRARY_READ_OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

/** request_library_file_access: creates a pending request; not destructive, not idempotent. */
const LIBRARY_REQUEST: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** read_library_file_access: reads the caller's own request. */
const LIBRARY_REQUEST_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const SCOPE_SENTENCE =
  "Library tools need a credential that covers the whole Workspace; a Product-only token or binding gets not found.";

const id = (description: string) => z.string().min(1).max(64).describe(description);

/** The input shapes (zod raw shapes), built fresh for each registration. */
export const LIBRARY_INPUT_SCHEMAS: Record<LibraryToolName, () => z.ZodRawShape> = {
  list_library: () => ({
    workspaceId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Workspace id. Defaults to the bound Workspace."),
    folderId: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("Folder to list. Omit for the Library root."),
    cursor: z.string().max(512).optional().describe("nextCursor from the previous page."),
    limit: z.number().int().min(1).max(100).optional().describe("Page size (1–100, default 50)."),
  }),
  read_library_file: () => ({ fileId: id("Library file id, from list_library.") }),
  get_library_file_link: () => ({ fileId: id("Library file id, from list_library.") }),
  read_library_file_content: () => ({ fileId: id("Library file id, from list_library.") }),
  request_library_file_access: () => ({
    fileId: id("Secret Library file id, from list_library."),
    // The API counts Unicode code points (runes) of the trimmed text, so
    // the check does too; the advertised JSON Schema stays 1–500.
    purpose: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "purpose must not be empty or only whitespace.",
      })
      .refine((value) => Array.from(value).length <= LIBRARY_PURPOSE_MAX_LENGTH, {
        message: `purpose must be at most ${LIBRARY_PURPOSE_MAX_LENGTH} characters.`,
      })
      .meta({ minLength: 1, maxLength: LIBRARY_PURPOSE_MAX_LENGTH })
      .describe(
        "Why you need the file (up to 500 characters). It is shown to the person who approves or rejects the request.",
      ),
  }),
  read_library_file_access: () => ({
    requestId: id("requestId returned by request_library_file_access."),
  }),
};

export interface LibraryToolDefinition {
  name: LibraryToolName;
  title: string;
  description: string;
  annotations: ToolAnnotations;
}

/** The six tools, in registration order. */
export const LIBRARY_TOOLS: readonly LibraryToolDefinition[] = [
  {
    name: "list_library",
    title: "List the Workspace Library",
    description: `List the folders and media files (images, videos and audio) of a Workspace Library, one folder at a time (the root when folderId is omitted), with cursor pagination. Each file shows its id, name, kind, content type, size, exposure (common or secret), folder path and dates. workspaceId defaults to the bound Workspace. Listing never returns file contents or links. ${SCOPE_SENTENCE}`,
    annotations: LIBRARY_READ,
  },
  {
    name: "read_library_file",
    title: "Read a Library file",
    description: `Read one Library file's metadata: name, kind, content type, size, exposure, folder path, uploader and dates. It never returns contents or links. For a common file use get_library_file_link or read_library_file_content; for a secret file use request_library_file_access. ${SCOPE_SENTENCE}`,
    annotations: LIBRARY_READ,
  },
  {
    name: "get_library_file_link",
    title: "Get a Library file link",
    description: `Get a temporary HTTPS link (valid for at most 15 minutes) to a common Library file, to hand to another tool that needs the file, for example another MCP server's import-from-URL tool. The link is temporary: pass it immediately to the tool that needs it and never store it in specifications, notes or memory. A secret file answers approval required: call request_library_file_access instead. ${SCOPE_SENTENCE}`,
    annotations: LIBRARY_READ_OPEN_WORLD,
  },
  {
    name: "read_library_file_content",
    title: "Read a Library file's content",
    description: `Return a common Library image or audio file of up to 10 MB as MCP image or audio content, so you can see or hear it. Videos and larger files are not returned: use get_library_file_link. Secret files are never returned: use request_library_file_access. ${SCOPE_SENTENCE}`,
    annotations: LIBRARY_READ_OPEN_WORLD,
  },
  {
    name: "request_library_file_access",
    title: "Request access to a secret Library file",
    description: `Ask a person to approve access to a secret Library file. State the purpose (up to 500 characters); it is shown to the person who decides. Returns a pending request with its requestId, expiresAt (10 minutes) and approvalUrl. Then ask the user to approve it in Kstonebase with their password, and call read_library_file_access. Client settings that allow all actions never approve a request. A common file needs no approval: use get_library_file_link. ${SCOPE_SENTENCE}`,
    annotations: LIBRARY_REQUEST,
  },
  {
    name: "read_library_file_access",
    title: "Read a Library access request",
    description:
      "Read the status of your access request for a secret Library file: pending, approved, rejected, expired or redeemed. Once approved it returns a one-time link that works once and expires 5 minutes after approval. Hand that link directly to the tool that needs the file; never fetch or open it through Kstonebase, and never store it. Only the credential that made the request can read it.",
    annotations: LIBRARY_REQUEST_READ,
  },
];

// ──────────────────────────────────────────────────────────────────────────
// Error texts (spec §3). The API's `details.code` decides the code.
// ──────────────────────────────────────────────────────────────────────────

export type LibraryErrorCode =
  | "LIBRARY_APPROVAL_REQUIRED"
  | "LIBRARY_CONTENT_TOO_LARGE"
  | "LIBRARY_NOT_SECRET"
  | "LIBRARY_TOO_MANY_PENDING"
  | "LIBRARY_STORAGE_UNAVAILABLE";

export const LIBRARY_ERROR_CODES: readonly LibraryErrorCode[] = [
  "LIBRARY_APPROVAL_REQUIRED",
  "LIBRARY_CONTENT_TOO_LARGE",
  "LIBRARY_NOT_SECRET",
  "LIBRARY_TOO_MANY_PENDING",
  "LIBRARY_STORAGE_UNAVAILABLE",
];

export const LIBRARY_ERROR_TEXT: Readonly<
  Record<LibraryErrorCode | "NOT_FOUND", { message: string; remediation: string }>
> = {
  LIBRARY_APPROVAL_REQUIRED: {
    message:
      "This file is Secret. Call request_library_file_access with a purpose and ask the user to approve it in Kstonebase.",
    remediation:
      "After the user approves, call read_library_file_access with the requestId to receive a one-time link. Client settings that allow all actions never replace that approval.",
  },
  LIBRARY_CONTENT_TOO_LARGE: {
    message:
      "This file is a video or larger than 10 MB, so it is not returned as content. Call get_library_file_link and pass the temporary link to the tool that needs the file.",
    remediation:
      "Only common images and audio files up to 10 MB are returned as MCP content; every other common file is available as a temporary link.",
  },
  LIBRARY_NOT_SECRET: {
    message:
      "This file is Common and needs no approval. Call get_library_file_link or read_library_file_content instead.",
    remediation: "Access requests are only for secret files.",
  },
  LIBRARY_TOO_MANY_PENDING: {
    message:
      "Too many access requests are waiting for a decision. Wait for the user to approve or reject them in Kstonebase before requesting again.",
    remediation:
      "Call read_library_file_access for your pending requests; a request expires 10 minutes after it was made.",
  },
  LIBRARY_STORAGE_UNAVAILABLE: {
    message: "The Library storage is temporarily unavailable.",
    remediation:
      "Nothing was returned or changed. Try again later; if it keeps failing, tell the user that the Kstonebase Library storage is unavailable.",
  },
  NOT_FOUND: {
    message: "Not found or outside this credential's scope.",
    remediation:
      "Check the id with list_library. The Library needs a credential that covers the whole Workspace: a Product-only token or binding sees no Library. An access request can be read only by the credential that made it. A Kstonebase server without the Library answers the same way.",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Result guidance (text items added after the JSON result).
// ──────────────────────────────────────────────────────────────────────────

const text = (value: unknown): string => (typeof value === "string" ? value : "unknown");

/** get_library_file_link. */
export function libraryLinkText(body: { expiresAt?: unknown }): string {
  return `Temporary link, valid until ${text(body.expiresAt)}. Pass it now, directly, to the tool that needs the file. Do not store it in specifications, notes or memory.`;
}

/** request_library_file_access. */
export function libraryRequestText(body: {
  requestId?: unknown;
  expiresAt?: unknown;
  approvalUrl?: unknown;
}): string {
  const where =
    typeof body.approvalUrl === "string" && body.approvalUrl.length > 0
      ? `in Kstonebase: ${body.approvalUrl}`
      : "in Kstonebase";
  return `Access requested; nothing is shared yet. Ask the user to approve this request ${where}. It expires at ${text(body.expiresAt)}. After the user approves, call read_library_file_access with requestId ${text(body.requestId)}.`;
}

/** read_library_file_access, by status. */
export function libraryAccessText(body: { status?: unknown; expiresAt?: unknown; url?: unknown }): string {
  switch (body.status) {
    case "approved":
      return typeof body.url === "string"
        ? `Approved. This one-time link works once and expires at ${text(body.expiresAt)}. Hand it directly to the tool that needs the file; never fetch or open it through Kstonebase, and never store it.`
        : "Approved, but the one-time link is no longer available. Request access again if you still need the file.";
    case "pending":
      return `Still waiting for a person to decide. Ask the user to approve it in Kstonebase, then read it again. It expires at ${text(body.expiresAt)}.`;
    case "rejected":
      return "Rejected. No link was issued; do not request again unless the user asks you to.";
    case "expired":
      return "Expired without a usable link. Request access again if the user still wants it.";
    case "redeemed":
      return "The one-time link was already used. Request access again if the file is needed once more.";
    default:
      return "No link is available for this request.";
  }
}
