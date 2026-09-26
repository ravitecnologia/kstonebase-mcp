// CLAUDE.md / AGENTS.md template body for `init_workspace` / `init_product`.
// Per Kstonebase MCP spec "mcp-setup-tools" §6 — the two files emitted by the
// tools carry byte-identical bodies. The template is content-neutral on
// purpose: users append their own project-specific guidance after the
// generated body.

export type SpecManagementType = "free" | "web_application";

export interface AgentDocsBinding {
  productId: string | null;
  productName: string | null;
  productType: SpecManagementType | null;
  workspaceId: string | null;
  workspaceName: string | null;
}

/**
 * Render the CLAUDE.md / AGENTS.md body for a binding. Pure function — the
 * caller writes it to disk (or, more precisely, returns it in the file plan
 * and lets the agent write it).
 */
export function renderAgentDocs(binding: AgentDocsBinding): string {
  const headerName = primaryName(binding);
  const introLine = renderIntroLine(binding);
  const boundEntity = renderBoundEntity(binding);
  const toolInventory = renderToolInventory(binding);
  const scopeNoun = binding.productId ? "product" : "workspace";
  const boundIdsLine = renderBoundIdsLine(binding);

  return [
    `# Agent instructions — ${headerName}`,
    "",
    `${introLine} Treat Kstonebase as the single source of truth for product, feature, and architectural documentation.`,
    "",
    "## Golden rule",
    "",
    `Before writing any spec, planning any feature, or producing non-trivial code, read the relevant specs from this ${scopeNoun} via the Kstonebase MCP server. Do not look for a \`docs/\` folder, \`SPECS/\` folder, or \`ARCHITECTURE.md\`. The repository is intentionally documentation-light; Kstonebase holds the authoritative copy.`,
    "",
    "## Bound entity",
    "",
    boundEntity,
    "",
    "## Available MCP tools",
    "",
    toolInventory,
    "",
    "## Workflow",
    "",
    "1. Search first (`search_specifications`, `list_specifications`) — if a spec exists for the topic, edit it; do not create a parallel document.",
    "2. Read the current version (`read_specification`) and capture its `version` for the write call.",
    "3. If the spec is Reviewed, call `start_new_version` first; writes against Reviewed specs fail.",
    "4. Edit with `update_specification_section` (targeted) or `update_specification_content` (full body).",
    "5. Resolve open questions explicitly. Mark assumptions in the document so reviewers can challenge them.",
    "6. Hand off for review (`request_review`). Do not mark specs Reviewed yourself — approval is a human action in the Kstonebase UI.",
    "",
    "## Bindings",
    "",
    `- \`.kstonebase.json\` in this directory binds ${boundIdsLine}.`,
    "",
    "Pass these ids to the Kstonebase MCP tools when a call needs an explicit target; otherwise the bound defaults apply.",
    "",
    "## Don'ts",
    "",
    "- Do not create local Markdown specs (`docs/`, `SPECS/`, `ARCHITECTURE.md`, `RFC-*.md`). Anything found on disk is either tooling config or stale.",
    "- Do not invent specifications inline in code, PR descriptions, or chat answers when one should exist in Kstonebase.",
    "- Do not skip `start_new_version` when editing a Reviewed spec — the write fails, and retrying without understanding why wastes time.",
    "- Do not assume your training data reflects the current state of a spec. Always read fresh.",
    "",
  ].join("\n");
}

function primaryName(binding: AgentDocsBinding): string {
  if (binding.productName) return binding.productName;
  if (binding.workspaceName) return binding.workspaceName;
  return "Kstonebase-bound project";
}

function renderIntroLine(binding: AgentDocsBinding): string {
  if (binding.productName && binding.workspaceName) {
    return `This project is bound to product **${binding.productName}** in workspace **${binding.workspaceName}** in Kstonebase.`;
  }
  if (binding.productName) {
    return `This project is bound to product **${binding.productName}** in Kstonebase.`;
  }
  if (binding.workspaceName) {
    return `This project is bound to workspace **${binding.workspaceName}** in Kstonebase.`;
  }
  return "This project is bound to an Kstonebase workspace or product.";
}

function renderBoundEntity(binding: AgentDocsBinding): string {
  const lines: string[] = [];
  const name = binding.productName ?? binding.workspaceName ?? "(unknown)";
  const typeLabel = renderTypeLabel(binding);
  const id = binding.productId ?? binding.workspaceId ?? "(unknown)";

  lines.push(`- Name: ${name}`);
  lines.push(`- Type: ${typeLabel}`);
  lines.push(`- Id: \`${id}\``);
  if (binding.productId && binding.workspaceId) {
    lines.push(
      `- Workspace: ${binding.workspaceName ?? "(unknown)"} (\`${binding.workspaceId}\`)`,
    );
  }
  return lines.join("\n");
}

function renderBoundIdsLine(binding: AgentDocsBinding): string {
  if (binding.productId && binding.workspaceId) {
    return `\`productId = ${binding.productId}\` inside \`workspaceId = ${binding.workspaceId}\``;
  }
  if (binding.productId) {
    return `\`productId = ${binding.productId}\``;
  }
  if (binding.workspaceId) {
    return `\`workspaceId = ${binding.workspaceId}\``;
  }
  return "no ids (unbound)";
}

function renderTypeLabel(binding: AgentDocsBinding): string {
  if (binding.productId) {
    if (binding.productType === "free") return "Free";
    if (binding.productType === "web_application") return "Web Application";
    return "Product";
  }
  return "Workspace";
}

interface ToolInventory {
  reads: string[];
  writes: string[];
}

function renderToolInventory(binding: AgentDocsBinding): string {
  const inv = buildToolInventory(binding);
  return [
    "Reads:",
    "",
    ...inv.reads.map((t) => `- \`${t}\``),
    "",
    "Writes:",
    "",
    ...inv.writes.map((t) => `- \`${t}\``),
  ].join("\n");
}

/**
 * Exported for tests — the inventory is the load-bearing per-product-type
 * branch in the template.
 */
export function buildToolInventory(binding: AgentDocsBinding): ToolInventory {
  // The read surface is the same across binding shapes — the agent gets the
  // full read toolkit regardless. The branch is in the write surface.
  const reads = [
    "list_specifications",
    "read_specification",
    "search_specifications",
    "list_specification_versions",
    "read_specification_version",
    "list_specification_changes",
    "read_specification_change",
    "list_open_questions",
    "read_open_question",
    "list_products",
    "read_product",
    "list_workspaces",
    "read_workspace",
    "find_product_by_subject",
  ];

  // Open-question tools work on Product (Free or Web Application) and
  // Workspace specifications alike, so they belong to every binding shape.
  const baseWrites = [
    "start_new_version",
    "update_specification_content",
    "update_specification_section",
    "append_context",
    "create_open_question",
    "update_open_question",
    "delete_open_question",
    "request_review",
    "discard_draft",
  ];

  // Per-binding writes:
  //   - Free product → can create new specs via create_free_specification.
  //   - Web Application product → no create_free_specification (rejected with
  //     PRODUCT_TYPE_MISMATCH).
  //   - Workspace-only binding → can create new Products via create_product.
  //   - Workspace + Free product → both, since the credential authorises both.
  //   - Workspace + Web Application product → create_product only.
  //   - Orphan product (no workspaceId) → no create_product.
  const writes = [...baseWrites];
  if (binding.productId && binding.productType === "free") {
    writes.push("create_free_specification");
  }
  if (binding.workspaceId) {
    writes.push("create_product");
  }
  return { reads, writes };
}
