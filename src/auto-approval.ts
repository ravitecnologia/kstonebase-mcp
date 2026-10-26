// Automatic approval of agent specification changes (Kstonebase Business ›
// features/agent-auto-approval.md; PBI 392). When the Product Owner turned on
// "Auto-approve agent changes" and the caller is that Owner, the write tools
// open a draft when a Reviewed target refuses the write, write, then request
// review — and the API approves it in the same request. The API alone decides
// eligibility (GET /api/mcp/products/:id answers autoApproval.eligible); an
// older API, a failed read or any other caller leaves every tool unchanged.
// A failed request for review never fails the write: the Draft stays and the
// result reports why. Same behavior as the Website-hosted transport.

import type { KstonebaseClient, WriteOptions } from "./client.js";
import { McpToolError } from "./errors.js";

/** The outcome of one automatic request for review. */
export interface AutoApprovalReport {
  applied: boolean;
  status?: string;
  approvedVersion?: number;
  openQuestionsCount?: number;
  reason?: string;
  error?: { code: string; message: string };
}

/** A report for one of several specifications written by the same call. */
export type AutoApprovalItem = AutoApprovalReport & { specificationId: string };

type AutoApprovalClient = Pick<
  KstonebaseClient,
  "readProduct" | "readSpecification" | "requestReview" | "startNewVersion"
>;

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Whether the caller's requests for review on the Product are approved automatically. */
export async function autoApprovalEligible(
  client: AutoApprovalClient,
  productId: string,
): Promise<boolean> {
  try {
    const product = obj((await client.readProduct(productId)).body);
    return obj(product?.autoApproval)?.eligible === true;
  } catch {
    return false;
  }
}

/** Request review of one Draft and report whether the API approved it. */
export async function requestAutoApproval(
  client: AutoApprovalClient,
  specId: string,
  options: WriteOptions,
): Promise<AutoApprovalReport> {
  try {
    const res = obj((await client.requestReview(specId, options)).body);
    const auto = obj(res?.autoApproval);
    const spec = obj(res?.spec);
    if (auto?.applied === true) {
      const report: AutoApprovalReport = {
        applied: true,
        status: str(auto.status) ?? str(spec?.status),
        approvedVersion: num(auto.approvedVersion) ?? num(spec?.approvedVersion),
      };
      const open = num(auto.openQuestionsCount);
      if (open !== undefined) report.openQuestionsCount = open;
      return report;
    }
    return {
      applied: false,
      status: str(spec?.status),
      reason: str(auto?.reason) ?? "NOT_APPLIED",
    };
  } catch (err) {
    const code = err instanceof McpToolError ? err.code : "INTERNAL_ERROR";
    const message = err instanceof Error ? err.message : "Request review failed.";
    return {
      applied: false,
      status: "DRAFT",
      reason: "REQUEST_REVIEW_FAILED",
      error: { code, message },
    };
  }
}

/** The written specification of a content, section or create result. */
function writtenSpec(
  data: unknown,
): { id: string; productId?: string; status?: string } | undefined {
  const spec = obj(obj(data)?.spec) ?? obj(data);
  const id = str(spec?.id);
  return id
    ? { id, productId: str(spec?.productId), status: str(spec?.status) }
    : undefined;
}

/**
 * After a successful single-specification write: request review of the
 * written Draft (and of the indexes the same call created) when eligible.
 * Returns the data with `autoApproval` added, or the data unchanged.
 */
export async function autoApproveWrite(
  client: AutoApprovalClient,
  data: unknown,
  options: WriteOptions,
): Promise<unknown> {
  const spec = writtenSpec(data);
  const body = obj(data);
  if (!body || !spec?.productId || spec.status !== "DRAFT") return data;
  if (!(await autoApprovalEligible(client, spec.productId))) return data;
  const report: AutoApprovalReport & { indexes?: AutoApprovalItem[] } =
    await requestAutoApproval(client, spec.id, options);
  const rawEffects = obj(body.spec)?.indexEffects;
  const effects = Array.isArray(rawEffects) ? rawEffects : [];
  const indexes: AutoApprovalItem[] = [];
  for (const effect of effects.map(obj)) {
    const id = str(effect?.specificationId);
    if (!id || effect?.action !== "created" || effect.status !== "DRAFT") continue;
    indexes.push({
      specificationId: id,
      ...(await requestAutoApproval(client, id, options)),
    });
  }
  if (indexes.length > 0) report.indexes = indexes;
  // The written spec reads as it is now: published, at the approved version.
  const written = obj(body.spec);
  const current =
    report.applied && written
      ? { ...written, status: report.status ?? "REVIEWED", approvedVersion: report.approvedVersion ?? written.approvedVersion }
      : body.spec;
  return { ...body, ...(written ? { spec: current } : {}), autoApproval: report };
}

const PLAN_ACTIONS = new Set(["create", "update", "create_index"]);

/**
 * After an applied authoring plan on a Product: request review of every
 * specification the plan created or updated that is now a Draft.
 */
export async function autoApprovePlan(
  client: AutoApprovalClient,
  container: { type: string; id: string },
  data: unknown,
  options: WriteOptions,
): Promise<unknown> {
  const body = obj(data);
  if (
    !body ||
    container.type !== "product" ||
    body.applied !== true ||
    body.replayed === true
  ) {
    return data;
  }
  const targets = (Array.isArray(body.results) ? body.results : [])
    .map(obj)
    .filter(
      (r) =>
        r &&
        PLAN_ACTIONS.has(String(r.action)) &&
        r.status === "DRAFT" &&
        str(r.specificationId),
    );
  if (targets.length === 0 || !(await autoApprovalEligible(client, container.id))) {
    return data;
  }
  const results: AutoApprovalItem[] = [];
  for (const r of targets) {
    const id = str(r?.specificationId) as string;
    results.push({
      specificationId: id,
      ...(await requestAutoApproval(client, id, options)),
    });
  }
  return { ...body, autoApproval: { results } };
}

/**
 * Before sending a write once more after a Reviewed specification refused
 * it with SPEC_LOCKED: open a new draft when the caller is eligible. True
 * when the draft was opened; the version the agent read stays valid because
 * a status change does not advance it.
 */
export async function openDraftForAutoApproval(
  client: AutoApprovalClient,
  specId: string,
  err: unknown,
  options: WriteOptions,
): Promise<boolean> {
  if (
    !(err instanceof McpToolError) ||
    err.code !== "SPEC_LOCKED" ||
    err.details?.status !== "REVIEWED"
  ) {
    return false;
  }
  try {
    const read = await client.readSpecification(specId);
    const spec = obj("body" in read ? read.body : undefined);
    const productId = str(spec?.productId);
    if (
      !productId ||
      spec?.status !== "REVIEWED" ||
      !(await autoApprovalEligible(client, productId))
    ) {
      return false;
    }
    await client.startNewVersion(specId, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a single-specification write with the automatic approval flow: on an
 * eligible SPEC_LOCKED refusal of a Reviewed target, open a draft and send
 * the write once more; after success, request review when eligible.
 */
export async function withAutoApproval(
  client: AutoApprovalClient,
  specId: string | undefined,
  options: WriteOptions,
  write: () => Promise<{ body: unknown }>,
): Promise<unknown> {
  let res: { body: unknown };
  try {
    res = await write();
  } catch (err) {
    if (!specId || !(await openDraftForAutoApproval(client, specId, err, options))) {
      throw err;
    }
    res = await write();
  }
  return autoApproveWrite(client, res.body, options);
}
