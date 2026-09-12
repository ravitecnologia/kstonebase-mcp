#!/usr/bin/env node
// CLI entry point for the @ravitecnologia/kstonebase-mcp package.
//
// Default invocation runs the stdio MCP server, which is what desktop
// agents (Claude Code, Cursor, Zed) launch as a child process.
// `--check` performs a token-validation smoke probe and exits 0/1.
// `--help` prints usage.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConfigError, resolveConfig } from "./config.js";
import { KstonebaseClient } from "./client.js";
import { McpToolError } from "./errors.js";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttpServer } from "./http.js";
import { logger } from "./logger.js";
import { detectLegacyBinding, runStdio } from "./server.js";

export interface ParsedArgs {
  command: "serve" | "check" | "help";
  /** Transport for `serve`. Default = stdio (desktop agents). */
  transport: "stdio" | "http";
  apiUrl?: string;
  port: number;
  host: string;
  corsOrigins: string[];
  allowInsecure: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: "serve",
    transport: "stdio",
    allowInsecure: false,
    json: false,
    port: DEFAULT_HTTP_PORT,
    host: DEFAULT_HTTP_HOST,
    corsOrigins: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") out.command = "check";
    else if (arg === "--help" || arg === "-h") out.command = "help";
    else if (arg === "--allow-insecure") out.allowInsecure = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--http") out.transport = "http";
    else if (arg === "--stdio") out.transport = "stdio";
    else if (arg === "--api-url") {
      out.apiUrl = expectValue(argv, ++i, "--api-url");
    } else if (arg.startsWith("--api-url=")) {
      out.apiUrl = arg.slice("--api-url=".length);
    } else if (arg === "--port") {
      out.port = parsePort(expectValue(argv, ++i, "--port"));
    } else if (arg.startsWith("--port=")) {
      out.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--host") {
      out.host = expectValue(argv, ++i, "--host");
    } else if (arg.startsWith("--host=")) {
      out.host = arg.slice("--host=".length);
    } else if (arg === "--cors-origin") {
      out.corsOrigins.push(expectValue(argv, ++i, "--cors-origin"));
    } else if (arg.startsWith("--cors-origin=")) {
      out.corsOrigins.push(arg.slice("--cors-origin=".length));
    } else if (arg === "serve") {
      out.command = "serve";
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function expectValue(argv: string[], index: number, name: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function parsePort(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got "${raw}"`);
  }
  return n;
}

const HELP_TEXT = `\
Usage: kstonebase-mcp [command] [options]

Commands:
  serve              Run the MCP server (default). Stdio unless --http is set.
  --check            Verify the token + API URL and exit 0/1.
  --help, -h         Show this message.

Transport flags (with serve):
  --stdio            Run over stdio for desktop agents (default).
  --http             Run as an HTTP/SSE server for hosted agents.
  --port <n>         Port for --http (default ${DEFAULT_HTTP_PORT}).
  --host <addr>      Host for --http (default ${DEFAULT_HTTP_HOST}).
  --cors-origin <o>  Origin to allow (repeatable). Without this, any
                     cross-origin browser request is rejected.

Other options:
  --api-url <url>    Override the Kstonebase API base URL.
  --allow-insecure   Permit a non-HTTPS apiUrl (self-hosted dev only).
  --json             Machine-readable output for --check.

Environment variables:
  KSTONEBASE_API_TOKEN      Personal Access Token (required).
  KSTONEBASE_API_URL        Override the API base URL.
  KSTONEBASE_WORKSPACE_ID   Default Workspace binding.
  KSTONEBASE_PRODUCT_ID     Default Product binding.
  KSTONEBASE_TELEMETRY      Set to "0" to disable anonymous telemetry.
  KSTONEBASE_LOG_LEVEL      debug | info | warn | error (default info).
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n${HELP_TEXT}`);
    return 2;
  }

  if (parsed.command === "help") {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  let config;
  try {
    config = resolveConfig({
      apiUrl: parsed.apiUrl,
      allowInsecure: parsed.allowInsecure,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (!config.token) {
    process.stderr.write(
      "KSTONEBASE_API_TOKEN is required. Generate one at /settings/developer and re-run.\n",
    );
    return 2;
  }

  if (parsed.command === "check") {
    return runCheck(config.apiUrl, config.token, parsed.json);
  }

  // Phase 4: probe for the legacy `.kstonebase.json` shape before
  // starting any transport. The error is non-fatal at the network level
  // (we keep listening) but the CLI prints a structured remediation and
  // exits — same UX as a missing token.
  try {
    const probeClient = new KstonebaseClient({
      apiUrl: config.apiUrl,
      token: config.token,
    });
    const legacy = await detectLegacyBinding(config, probeClient);
    if (legacy) {
      const failure = legacy.toFailure();
      process.stderr.write(
        `${failure.code}: ${failure.message}\n${failure.remediation}\n`,
      );
      return 2;
    }
  } catch (err) {
    // Probe failures (network, auth) shouldn't block startup — the agent
    // surfaces those on the first real call. Just log so they show up in
    // diagnostics.
    logger.warn("legacy binding probe skipped", {
      err: (err as Error).message,
    });
  }

  if (parsed.transport === "http") {
    const handle = await startHttpServer({
      config,
      port: parsed.port,
      host: parsed.host,
      corsOrigins: parsed.corsOrigins,
    });
    process.stderr.write(
      `Listening on http://${handle.host}:${handle.port}/mcp\n`,
    );
    // The HTTP server keeps the event loop alive — return 0 here only
    // when a future shutdown signal triggers handle.close(). For now we
    // just await indefinitely.
    await new Promise<void>(() => {});
    return 0;
  }

  await runStdio(config);
  return 0;
}

async function runCheck(
  apiUrl: string,
  token: string,
  asJson: boolean,
): Promise<number> {
  const client = new KstonebaseClient({ apiUrl, token });
  try {
    const probe = await client.checkAuth();
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, apiUrl, products: probe.products })}\n`,
      );
    } else {
      process.stdout.write(
        `OK: ${apiUrl} reachable, ${probe.products} product(s) visible.\n`,
      );
    }
    return 0;
  } catch (err) {
    const failure =
      err instanceof McpToolError
        ? err.toFailure()
        : {
            code: "INTERNAL_ERROR" as const,
            message: (err as Error).message,
            remediation: "Retry; if it persists, check the API URL and token.",
          };
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, ...failure })}\n`,
      );
    } else {
      process.stderr.write(
        `FAILED (${failure.code}): ${failure.message}\n${failure.remediation}\n`,
      );
    }
    return 1;
  }
}

// Allow `node cli.js` direct execution while staying importable for tests.
// We compare realpaths because `npx -y @ravitecnologia/kstonebase-mcp` invokes this file
// through the bin symlink at `node_modules/.bin/kstonebase-mcp` — without
// realpath resolution, `process.argv[1]` (the symlink) would never equal
// `import.meta.url` (the real path), and `main()` would silently never run.
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    const entryPath = realpathSync(process.argv[1]);
    const modulePath = fileURLToPath(import.meta.url);
    return entryPath === modulePath;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      logger.error("mcp server crashed", { err: (err as Error).message });
      process.exit(1);
    },
  );
}
