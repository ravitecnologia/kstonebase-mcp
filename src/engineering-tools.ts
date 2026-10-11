// Engineering discovery, read and assessment tools of the standalone package
// (Kstonebase MCP › features/mcp-engineering-tools.md ME1–ME8, PBI 230 / D1;
// API › features/agent-engineering-contract.md §1–§7).
//
// Names, titles, descriptions, annotations, input schemas and API requests
// come from the shared catalog (./engineering-catalog), the same file the
// Kstonebase-hosted and Desktop session registry uses, so the stdio and
// --http transports advertise exactly what every other transport does (ME1).
// Results are the API bodies, unchanged; every successful result carries the
// Workspace instructions notice of the Product or Workspace it addresses
// (ME7). The API decides delegation, credential scope, consent and provider
// grants; nothing here widens access, retries or writes.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { KstonebaseClient } from "./client.js";
import type { ResolvedConfig } from "./config.js";
import {
  ENGINEERING_WORKSPACE_TOOLS,
  EngineeringArgumentError,
  buildEngineeringRequest,
  registerEngineeringCatalog,
} from "./engineering-catalog.js";
import { McpToolError } from "./errors.js";
import type { PolicyNotices } from "./policy.js";
import { createToolRunner, ok } from "./tools.js";

interface EngineeringToolDeps {
  client: KstonebaseClient;
  config: ResolvedConfig;
  policy: PolicyNotices;
}

export function registerEngineeringTools(
  server: McpServer,
  deps: EngineeringToolDeps,
): void {
  const { client, config } = deps;
  const runTool = createToolRunner(deps.policy);

  registerEngineeringCatalog(server, (name, args) =>
    runTool(
      name,
      {
        workspaceId: args.workspaceId,
        productId: args.productId,
        itemId: args.itemId,
      },
      async (call) => {
        // Workspace tools fall back to the bound Workspace, like the Board
        // tools; a bound productId never selects a Workspace.
        let workspaceId: string | undefined;
        if (ENGINEERING_WORKSPACE_TOOLS.has(name)) {
          workspaceId =
            typeof args.workspaceId === "string" && args.workspaceId.length > 0
              ? args.workspaceId
              : (config.workspaceId ?? undefined);
          if (!workspaceId) {
            throw new McpToolError(
              "WORKSPACE_NOT_BOUND",
              "This engineering tool needs a Workspace, and none is bound to this MCP session. A productId binding never selects a Workspace.",
              "Pass workspaceId, or call list_workspaces, pick the Workspace, then add it to .kstonebase.json as `workspaceId` or set KSTONEBASE_WORKSPACE_ID.",
            );
          }
        }
        let request;
        try {
          request = buildEngineeringRequest(name, args, workspaceId);
        } catch (err) {
          if (err instanceof EngineeringArgumentError) {
            throw new McpToolError(
              "VALIDATION_ERROR",
              err.message,
              "Fix that argument instead of retrying it unchanged.",
              { field: err.field, problem: err.problem },
            );
          }
          throw err;
        }
        call.addresses(request.target);
        const res = await client.engineeringRequest(
          request.method,
          request.path,
          request.body,
        );
        return ok(res.body);
      },
    ),
  );
}
