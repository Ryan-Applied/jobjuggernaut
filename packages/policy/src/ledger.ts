/**
 * Ledger generation: the planner's dry run turned into rows you can sign.
 * Pure function over a task's step definitions, the workflow's grant template
 * and the standing forbid rules. No I/O, so the API and tests share it.
 */
import type { Grant, Ledger, PolicyCheck } from "@jj/core";
import { FORBID_RULES } from "./forbid.js";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface IntendedAction { tool: string; scope?: Record<string, string | string[]>; cap?: { count?: number; gbp?: number }; source: string }
export interface StepDef { name: string; intendedActions?: Array<{ tool: string; scope?: Record<string, string | string[]>; cap?: { count?: number; gbp?: number } }>; maxCostGbp?: number }
export interface TemplateGrant { action: string; scope?: Record<string, string | string[]>; cap?: { count?: number; gbp?: number } }

/** Resource attributes the forbid rules need, derived from the action's declared scope. */
export function resourceFromScope(tool: string, scope: Record<string, string | string[]> = {}): Record<string, unknown> {
  const first = (k: string) => { const v = scope[k]; return Array.isArray(v) ? v[0] : v; };
  const res: Record<string, unknown> = {};
  if (tool === "gmail.send") res.external = !!first("to") && !String(first("to")).endsWith(String(process.env.JJ_INTERNAL_EMAIL_DOMAIN ?? "@appliedcomputing.com"));
  if (tool === "slack.post") res.slackConnect = String(first("channel") ?? "").includes("shared") || first("slackConnect") === "true";
  if (tool === "jira.transition") res.toStatus = first("toStatus");
  return res;
}

/** Walk the steps and the template and produce the intended-action list the ledger is built from. */
export function dryRun(steps: StepDef[], template: TemplateGrant[] = []): IntendedAction[] {
  const out = new Map<string, IntendedAction>();
  for (const g of template) out.set(g.action, { tool: g.action, scope: g.scope ?? {}, cap: g.cap ?? {}, source: "template" });
  for (const s of steps) for (const a of s.intendedActions ?? []) {
    const prev = out.get(a.tool);
    out.set(a.tool, { tool: a.tool, scope: { ...(prev?.scope ?? {}), ...(a.scope ?? {}) }, cap: mergeCap(prev?.cap, a.cap), source: prev ? `${prev.source}, ${s.name}` : s.name });
  }
  const totalGbp = steps.reduce((a, s) => a + (s.maxCostGbp ?? 0), 0);
  if (totalGbp > 0) out.set("spend", { tool: "spend", scope: {}, cap: { gbp: Math.ceil(totalGbp * 1.1 * 100) / 100 }, source: "steps" });
  return [...out.values()];
}
function mergeCap(a?: { count?: number; gbp?: number }, b?: { count?: number; gbp?: number }) {
  return { count: a?.count !== undefined || b?.count !== undefined ? (a?.count ?? 0) + (b?.count ?? 0) : undefined, gbp: a?.gbp !== undefined || b?.gbp !== undefined ? (a?.gbp ?? 0) + (b?.gbp ?? 0) : undefined };
}

/** Split intended actions into pre-authorisable grants and never-pre-authorised rows. */
export function buildLedger(input: { taskId: string; steps: StepDef[]; template?: TemplateGrant[]; expiresAt: string; now?: Date }): Ledger {
  const ledgerId = crypto.randomUUID();
  const grants: Grant[] = []; const never: Ledger["neverPreAuthorised"] = [];
  for (const a of dryRun(input.steps, input.template)) {
    const check: PolicyCheck = { sessionId: "00000000-0000-4000-8000-000000000000", tool: a.tool, args: flatten(a.scope), resource: resourceFromScope(a.tool, a.scope) };
    const rule = FORBID_RULES.find((r) => r.matches(check));
    if (rule) { never.push({ action: a.tool, reason: rule.reason }); continue; }
    grants.push({ id: crypto.randomUUID(), ledgerId, action: a.tool, scope: a.scope ?? {}, cap: a.cap ?? {}, used: { count: 0, gbp: 0 }, expiresAt: input.expiresAt, delegated: false });
  }
  return { id: ledgerId, taskId: input.taskId, generatedAt: (input.now ?? new Date()).toISOString(), expiresAt: input.expiresAt, status: "draft", grants, neverPreAuthorised: never };
}
const flatten = (scope: Record<string, string | string[]> = {}) => Object.fromEntries(Object.entries(scope).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));

/**
 * Signing. Phase 3 uses an HMAC over the canonical grant set with a server-held
 * secret so the ledger cannot be edited after you sign it; WebAuthn (browser-held key)
 * replaces this in Phase 4. Delegated grants (widened from Slack) are signed the same
 * way but flagged, so the morning brief can show them separately.
 */
export function canonicalGrants(grants: Grant[]): string {
  return JSON.stringify(grants.map((g) => ({ a: g.action, s: g.scope, c: g.cap, e: g.expiresAt, d: g.delegated })).sort((x, y) => x.a.localeCompare(y.a)));
}
export function signLedger(ledger: Ledger, secret: string): string {
  return createHmac("sha256", secret).update(`${ledger.id}|${ledger.expiresAt}|${canonicalGrants(ledger.grants)}`).digest("base64url");
}
export function verifyLedger(ledger: Ledger, signature: string, secret: string): boolean {
  const expected = Buffer.from(signLedger(ledger, secret)); const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/** The grant a "widen" from Slack creates: exactly the gap, nothing more. */
export function grantForGap(ledgerId: string, tool: string, args: Record<string, unknown>, expiresAt: string): Grant {
  const scope: Record<string, string> = {};
  for (const k of ["repo", "branch", "channel", "to", "path", "space", "issue", "project"]) if (typeof args[k] === "string") scope[k] = args[k] as string;
  return { id: crypto.randomUUID(), ledgerId, action: tool, scope, cap: { count: 5 }, used: { count: 0, gbp: 0 }, expiresAt, delegated: true };
}
