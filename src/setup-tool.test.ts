import { describe, expect, it, vi } from "vitest";

import { McpToolError } from "./errors.js";
import {
  renderKstonebaseJson,
  runInitProduct,
  runInitWorkspace,
  type InitDeps,
  type InitResult,
  type NeedsSelectionResult,
  type PlannedResult,
  type ProductCandidate,
  type TransportKind,
  type WorkspaceCandidate,
} from "./setup-tool.js";
import { buildToolInventory, renderAgentDocs } from "./templates/agent-docs.js";

interface FakeClientState {
  workspaces: Record<string, { name: string }>;
  products: Record<
    string,
    {
      name: string;
      specificationManagementType: "free" | "web_application";
      workspaceId: string | null;
    }
  >;
}

function fakeClient(state: FakeClientState) {
  return {
    readWorkspace: vi.fn(async (id: string) => {
      const ws = state.workspaces[id];
      if (!ws) {
        throw new McpToolError(
          "NOT_FOUND",
          `Workspace ${id} not found.`,
          "Check the id with list_workspaces.",
        );
      }
      return { body: { id, ...ws }, etag: null, status: 200 };
    }),
    readProduct: vi.fn(async (id: string) => {
      const p = state.products[id];
      if (!p) {
        throw new McpToolError(
          "NOT_FOUND",
          `Product ${id} not found.`,
          "Check the id with list_products.",
        );
      }
      return { body: { id, ...p }, etag: null, status: 200 };
    }),
    listWorkspaces: vi.fn(async () => ({
      body: {
        items: Object.entries(state.workspaces).map(([id, w]) => ({
          id,
          name: w.name,
        })),
      },
      etag: null,
      status: 200,
    })),
    listProducts: vi.fn(
      async (opts: { workspaceId?: string; orphan?: boolean } = {}) => {
        const items = Object.entries(state.products)
          .filter(([, p]) =>
            opts.workspaceId
              ? p.workspaceId === opts.workspaceId
              : opts.orphan
                ? p.workspaceId === null
                : true,
          )
          .map(([id, p]) => ({
            id,
            name: p.name,
            specificationManagementType: p.specificationManagementType,
            workspaceId: p.workspaceId,
          }));
        return { body: { items }, etag: null, status: 200 };
      },
    ),
  } as unknown as InitDeps["client"];
}

function deps(
  client: ReturnType<typeof fakeClient>,
  overrides: Partial<InitDeps> = {},
): InitDeps {
  return {
    client,
    cwd: "/tmp/project",
    transport: "stdio" as TransportKind,
    ...overrides,
  };
}

function planned(r: InitResult): PlannedResult {
  expect(r.status).toBe("planned");
  return r as PlannedResult;
}

function selection(r: InitResult): NeedsSelectionResult {
  expect(r.status).toBe("needs_selection");
  return r as NeedsSelectionResult;
}

const baseState: FakeClientState = {
  workspaces: { W1: { name: "RaviTecnologia" }, W2: { name: "Second WS" } },
  products: {
    P_FREE: {
      name: "Kstonebase Website",
      specificationManagementType: "free",
      workspaceId: "W1",
    },
    P_WEB: {
      name: "Some Web App",
      specificationManagementType: "web_application",
      workspaceId: "W1",
    },
    P_ORPHAN: {
      name: "Orphan Product",
      specificationManagementType: "free",
      workspaceId: null,
    },
  },
};

describe("runInitWorkspace — selection", () => {
  it("returns needs_selection with the workspace candidates when no id is resolvable", async () => {
    const client = fakeClient(baseState);
    const result = selection(await runInitWorkspace({}, deps(client)));
    expect(result.scope).toBe("workspace");
    expect((result.candidates as WorkspaceCandidate[]).map((c) => c.id)).toEqual(
      ["W1", "W2"],
    );
    expect(result.nextStep).toContain("init_workspace again");
    expect(result).not.toHaveProperty("files");
    expect(client.readWorkspace).not.toHaveBeenCalled();
  });

  it("an existing binding suppresses selection (has .kstonebase.json branch)", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitWorkspace(
        {
          existingFiles: [".kstonebase.json"],
          existingKstonebaseJson: JSON.stringify({ workspaceId: "W1" }, null, 2),
        },
        deps(client),
      ),
    );
    expect(result.binding.workspaceId).toBe("W1");
    const kstonebase = result.files.find((f) => f.path === ".kstonebase.json")!;
    expect(kstonebase.action).toBe("skip");
  });

  it("the process binding suppresses selection", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitWorkspace({}, deps(client, { boundWorkspaceId: "W2" })),
    );
    expect(result.binding.workspaceId).toBe("W2");
  });

  it("resolves the effective id explicit > file > process binding", async () => {
    const client = fakeClient(baseState);
    expect(
      planned(
        await runInitWorkspace(
          {
            workspaceId: "W1",
            existingKstonebaseJson: JSON.stringify({ workspaceId: "W2" }),
          },
          deps(client, { boundWorkspaceId: "W2" }),
        ),
      ).binding.workspaceId,
    ).toBe("W1");
    expect(
      planned(
        await runInitWorkspace(
          { existingKstonebaseJson: JSON.stringify({ workspaceId: "W1" }) },
          deps(client, { boundWorkspaceId: "W2" }),
        ),
      ).binding.workspaceId,
    ).toBe("W1");
  });
});

describe("runInitWorkspace — file plan", () => {
  it("binds a workspace only (one-key .kstonebase.json)", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitWorkspace({ workspaceId: "W1" }, deps(client)),
    );
    expect(result.files.map((f) => f.path)).toEqual([
      ".kstonebase.json",
      "CLAUDE.md",
      "AGENTS.md",
    ]);
    expect(JSON.parse(result.files[0].content)).toEqual({ workspaceId: "W1" });
    expect(result.binding.productId).toBeNull();
    expect(result.binding.productType).toBeNull();
    expect(result.files[1].content).toBe(result.files[2].content);
  });

  it("emits only .kstonebase.json when includeAgentDocs is false", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitWorkspace(
        { workspaceId: "W1", includeAgentDocs: false },
        deps(client),
      ),
    );
    expect(result.files.map((f) => f.path)).toEqual([".kstonebase.json"]);
  });

  it("propagates NOT_FOUND from read_workspace", async () => {
    const client = fakeClient(baseState);
    await expect(
      runInitWorkspace({ workspaceId: "MISSING" }, deps(client)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("propagates TOKEN_SCOPE_MISMATCH from read_workspace", async () => {
    const client = {
      readWorkspace: vi.fn(async () => {
        throw new McpToolError(
          "TOKEN_SCOPE_MISMATCH",
          "Out of allowlist.",
          "Re-issue the token.",
        );
      }),
    } as unknown as ReturnType<typeof fakeClient>;
    await expect(
      runInitWorkspace({ workspaceId: "W1" }, deps(client)),
    ).rejects.toMatchObject({ code: "TOKEN_SCOPE_MISMATCH" });
  });
});

describe("runInitProduct — selection", () => {
  it("returns product candidates scoped to a known workspace", async () => {
    const client = fakeClient(baseState);
    const result = selection(
      await runInitProduct({ workspaceId: "W1" }, deps(client)),
    );
    expect(result.scope).toBe("product");
    expect((result.candidates as ProductCandidate[]).map((c) => c.id)).toEqual([
      "P_FREE",
      "P_WEB",
    ]);
    expect(result.nextStep).toContain("workspaceId");
  });

  it("returns orphan products when no workspace is known", async () => {
    const client = fakeClient(baseState);
    const result = selection(await runInitProduct({}, deps(client)));
    expect((result.candidates as ProductCandidate[]).map((c) => c.id)).toEqual([
      "P_ORPHAN",
    ]);
  });

  it("an existing product binding suppresses selection", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct(
        { existingKstonebaseJson: JSON.stringify({ productId: "P_FREE" }) },
        deps(client),
      ),
    );
    expect(result.binding.productId).toBe("P_FREE");
  });
});

describe("runInitProduct — file plan", () => {
  it("binds a member product and its workspace", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct({ productId: "P_FREE" }, deps(client)),
    );
    expect(result.binding).toEqual({
      workspaceId: "W1",
      workspaceName: "RaviTecnologia",
      productId: "P_FREE",
      productName: "Kstonebase Website",
      productType: "free",
    });
    expect(JSON.parse(result.files[0].content)).toEqual({
      workspaceId: "W1",
      productId: "P_FREE",
    });
    expect(result.nextStep).toContain("restart");
  });

  it("binds an orphan product (one-key .kstonebase.json)", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct({ productId: "P_ORPHAN" }, deps(client)),
    );
    expect(JSON.parse(result.files[0].content)).toEqual({
      productId: "P_ORPHAN",
    });
    expect(result.binding.workspaceId).toBeNull();
  });

  it("rejects a workspaceId that is not the product's own", async () => {
    const client = fakeClient({
      ...baseState,
      products: {
        ...baseState.products,
        P_OTHER: {
          name: "Belongs Elsewhere",
          specificationManagementType: "free",
          workspaceId: "W_OTHER",
        },
      },
    });
    await expect(
      runInitProduct({ productId: "P_OTHER", workspaceId: "W1" }, deps(client)),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("W1"),
    });
  });

  it("propagates NOT_FOUND from read_product", async () => {
    const client = fakeClient(baseState);
    await expect(
      runInitProduct({ productId: "MISSING" }, deps(client)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("runInitProduct — existing-file handshake", () => {
  it("skips every file when .kstonebase.json matches and templates already exist", async () => {
    const client = fakeClient(baseState);
    const kstonebaseJson = renderKstonebaseJson({
      productId: "P_FREE",
      productName: null,
      productType: null,
      workspaceId: "W1",
      workspaceName: null,
    });
    const result = planned(
      await runInitProduct(
        {
          productId: "P_FREE",
          existingFiles: [".kstonebase.json", "CLAUDE.md", "AGENTS.md"],
          existingKstonebaseJson: kstonebaseJson,
        },
        deps(client),
      ),
    );
    expect(result.files.map((f) => f.action)).toEqual(["skip", "skip", "skip"]);
    for (const f of result.files) {
      expect(f.alreadyExists).toBe(true);
      expect(f.content.length).toBeGreaterThan(0);
    }
    expect(result.nextStep).toContain("Every file is already in place");
  });

  it("marks .kstonebase.json as conflict when existing binds different ids", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct(
        {
          productId: "P_FREE",
          existingFiles: [".kstonebase.json"],
          existingKstonebaseJson: JSON.stringify({ productId: "P_WEB" }, null, 2),
        },
        deps(client),
      ),
    );
    const kstonebase = result.files.find((f) => f.path === ".kstonebase.json")!;
    expect(kstonebase.action).toBe("conflict");
    expect(result.nextStep).toContain("conflict");
  });

  it("treats unparseable .kstonebase.json as conflict, not a resolved binding", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct(
        {
          productId: "P_FREE",
          existingFiles: [".kstonebase.json"],
          existingKstonebaseJson: "{ not valid json",
        },
        deps(client),
      ),
    );
    const kstonebase = result.files.find((f) => f.path === ".kstonebase.json")!;
    expect(kstonebase.action).toBe("conflict");
  });

  it("force=true overwrites every file regardless of state", async () => {
    const client = fakeClient(baseState);
    const result = planned(
      await runInitProduct(
        {
          productId: "P_FREE",
          force: true,
          existingFiles: [".kstonebase.json", "CLAUDE.md", "AGENTS.md"],
          existingKstonebaseJson: JSON.stringify({ productId: "P_WEB" }, null, 2),
        },
        deps(client),
      ),
    );
    for (const f of result.files) {
      expect(f.action).toBe("overwrite");
      expect(f.alreadyExists).toBe(true);
    }
  });
});

describe("nextStep per transport", () => {
  it("tells the user to restart the MCP client for the user-run package", async () => {
    const client = fakeClient(baseState);
    const stdio = planned(
      await runInitProduct(
        { productId: "P_FREE" },
        deps(client, { transport: "stdio" }),
      ),
    );
    const http = planned(
      await runInitProduct(
        { productId: "P_FREE" },
        deps(client, { transport: "http" }),
      ),
    );
    expect(stdio.nextStep).toContain("restart");
    expect(http.nextStep).toContain("restart");
  });

  it("omits restart guidance for the remote-endpoint transport", async () => {
    const client = fakeClient(baseState);
    const remote = planned(
      await runInitProduct(
        { productId: "P_FREE" },
        deps(client, { transport: "remote-endpoint" }),
      ),
    );
    expect(remote.nextStep).not.toContain("restart");
    expect(remote.nextStep).toContain("takes effect on the next tool call");
  });
});

describe("renderKstonebaseJson", () => {
  it("emits keys in workspaceId → productId order with a trailing newline", () => {
    const json = renderKstonebaseJson({
      productId: "P",
      productName: null,
      productType: null,
      workspaceId: "W",
      workspaceName: null,
    });
    expect(json.endsWith("\n")).toBe(true);
    const keys = Object.keys(JSON.parse(json));
    expect(keys).toEqual(["workspaceId", "productId"]);
  });

  it("omits keys that are not bound", () => {
    expect(
      JSON.parse(
        renderKstonebaseJson({
          productId: null,
          productName: null,
          productType: null,
          workspaceId: "W",
          workspaceName: null,
        }),
      ),
    ).toEqual({ workspaceId: "W" });
    expect(
      JSON.parse(
        renderKstonebaseJson({
          productId: "P",
          productName: null,
          productType: null,
          workspaceId: null,
          workspaceName: null,
        }),
      ),
    ).toEqual({ productId: "P" });
  });
});

describe("agent-docs template", () => {
  it("renders the Golden Rule paragraph verbatim", () => {
    const body = renderAgentDocs({
      productId: "P",
      productName: "Acme",
      productType: "free",
      workspaceId: null,
      workspaceName: null,
    });
    expect(body).toContain("## Golden rule");
    expect(body).toContain(
      "Before writing any spec, planning any feature, or producing non-trivial code",
    );
  });

  it("includes the bound entity's name and id, and a Bindings section", () => {
    const body = renderAgentDocs({
      productId: "P_FREE",
      productName: "Kstonebase Website",
      productType: "free",
      workspaceId: "W1",
      workspaceName: "RaviTecnologia",
    });
    expect(body).toContain("Kstonebase Website");
    expect(body).toContain("`P_FREE`");
    expect(body).toContain("RaviTecnologia");
    expect(body).toContain("`W1`");
    expect(body).toContain("## Bindings");
    expect(body).toContain("`productId = P_FREE` inside `workspaceId = W1`");
  });

  it("renders a workspace-only Bindings line", () => {
    const body = renderAgentDocs({
      productId: null,
      productName: null,
      productType: null,
      workspaceId: "W1",
      workspaceName: "RaviTecnologia",
    });
    expect(body).toContain("`workspaceId = W1`");
    expect(body).toContain("read the relevant specs from this workspace");
  });

  it("builds the right tool inventory per binding shape", () => {
    const free = buildToolInventory({
      productId: "P",
      productName: "f",
      productType: "free",
      workspaceId: null,
      workspaceName: null,
    });
    expect(free.writes).toContain("create_free_specification");
    expect(free.writes).not.toContain("create_product");

    const web = buildToolInventory({
      productId: "P",
      productName: "w",
      productType: "web_application",
      workspaceId: null,
      workspaceName: null,
    });
    expect(web.writes).not.toContain("create_free_specification");
    expect(web.writes).not.toContain("create_product");

    const workspaceOnly = buildToolInventory({
      productId: null,
      productName: null,
      productType: null,
      workspaceId: "W",
      workspaceName: "ws",
    });
    expect(workspaceOnly.writes).toContain("create_product");
    expect(workspaceOnly.writes).not.toContain("create_free_specification");

    const both = buildToolInventory({
      productId: "P",
      productName: "f",
      productType: "free",
      workspaceId: "W",
      workspaceName: "ws",
    });
    expect(both.writes).toContain("create_free_specification");
    expect(both.writes).toContain("create_product");
  });
});
