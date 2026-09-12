// Public entry for the @ravitecnologia/kstonebase-mcp package. Most users invoke the
// CLI via `npx -y @ravitecnologia/kstonebase-mcp`; this module exists so library
// consumers (e.g. an integration test or an embedded MCP gateway) can
// build the same server programmatically.

export { buildServer, runStdio } from "./server.js";
export { resolveConfig, ConfigError, DEFAULT_API_URL } from "./config.js";
export {
  KstonebaseClient,
  type ApiResponse,
  type NotModified,
} from "./client.js";
export {
  McpToolError,
  mapApiError,
  buildClientFailure,
  type McpFailure,
  type McpStructuredCode,
} from "./errors.js";
