// Build the MCP server, register tools/resources, and connect a stdio
// transport. Kept distinct from the CLI so tests can construct the server
// without spawning a child process.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import { McpToolError } from "./errors.js";
import { logger } from "./logger.js";
import { registerReadTools, registerWriteTools } from "./tools.js";
import { registerResources } from "./resources.js";

const SERVER_NAME = "@ravitecnologia/kstonebase-mcp";
const SERVER_VERSION = "2.0.0";

export interface BuildServerOptions {
  config: ResolvedConfig;
  /** Test override — replaces the built-in HTTP client. */
  client?: KstonebaseClient;
}

export function buildServer(options: BuildServerOptions): McpServer {
  const { config } = options;
  if (!config.token) {
    throw new Error(
      "KSTONEBASE_API_TOKEN is required. Generate one at /settings/developer.",
    );
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        logging: {},
      },
    },
  );

  const client =
    options.client ??
    new KstonebaseClient({ apiUrl: config.apiUrl, token: config.token });

  registerReadTools(server, { client, config });
  registerWriteTools(server, { client, config });
  registerResources(server, { client, config });

  return server;
}

/** Anything with a settable `onclose` hook — matches StdioServerTransport. */
export interface ClosableTransport {
  onclose?: (() => void) | undefined;
}

/**
 * Resolves only when the transport's `onclose` fires. Used to keep the
 * stdio process alive after `server.connect()` returns — without this, the
 * CLI exits before the agent can send `initialize`.
 */
export function waitForTransportClose(transport: ClosableTransport): Promise<void> {
  return new Promise<void>((resolve) => {
    const prev = transport.onclose;
    transport.onclose = () => {
      prev?.();
      resolve();
    };
  });
}

export async function runStdio(config: ResolvedConfig): Promise<void> {
  const server = buildServer({ config });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp server connected", {
    transport: "stdio",
    apiUrl: config.apiUrl,
    apiUrlSource: config.apiUrlSource,
    bindingMode: config.bindingMode,
    workspaceId: config.workspaceId ?? undefined,
    workspaceSource: config.workspaceSource,
    productId: config.productId ?? undefined,
    productSource: config.productSource,
  });
  await waitForTransportClose(transport);
}

/**
 * Phase 4 startup probe: detect the legacy `.kstonebase.json` shape
 * (`{"workspaceId": "<old id>"}` whose value is now a Product id, not a
 * Workspace id) and emit `LEGACY_BINDING_DETECTED` with an exact remediation
 * (per mcp-workspace-tools.md §5). Returns `null` when the binding looks
 * fine; returns an `McpToolError` the CLI can print and exit on.
 *
 * Triggers when:
 *   * `workspaceId` is set on the binding, AND
 *   * the API confirms it resolves to a Product (not a Workspace).
 *
 * Best-effort: API errors other than 404 propagate so transient connectivity
 * problems don't masquerade as the legacy shape.
 */
export async function detectLegacyBinding(
  config: ResolvedConfig,
  client: KstonebaseClient,
): Promise<McpToolError | null> {
  if (!config.workspaceId) return null;
  const shape = await client.resolveIdShape(config.workspaceId);
  if (shape !== "product") return null;
  return new McpToolError(
    "LEGACY_BINDING_DETECTED",
    `The "workspaceId" in .kstonebase.json (${config.workspaceId}) refers to a Product under the new model.`,
    'Edit .kstonebase.json: rename "workspaceId" to "productId" to keep current behaviour. To bind a Workspace, create one and set both ids.',
  );
}
