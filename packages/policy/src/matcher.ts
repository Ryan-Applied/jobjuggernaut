import type { Grant, PolicyCheck, PolicyResult } from "@jj/core";

/** Glob with `*` only, anchored. "chore/*" matches "chore/deps-nov". */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("*").map(escape).join(".*") + "$");
  return re.test(value);
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every scope key must be present in args/resource and match one of its patterns. */
export function scopeMatches(scope: Grant["scope"], c: PolicyCheck): { ok: boolean; gap?: string } {
  for (const [key, pat] of Object.entries(scope)) {
    const actual = (c.args[key] ?? c.resource[key]) as unknown;
    if (actual === undefined) return { ok: false, gap: `call has no ${key}` };
    const patterns = Array.isArray(pat) ? pat : [pat];
    const values = Array.isArray(actual) ? actual : [actual];
    const allOk = values.every((v) => patterns.some((p) => globMatch(p, String(v))));
    if (!allOk) return { ok: false, gap: `grant covers ${key} ${patterns.join(", ")}, call wants ${values.join(", ")}` };
  }
  return { ok: true };
}

export function hasRoom(g: Grant, spendGbp = 0): { ok: boolean; gap?: string } {
  if (g.cap.count !== undefined && g.used.count >= g.cap.count)
    return { ok: false, gap: `cap reached: ${g.used.count} of ${g.cap.count} calls` };
  if (g.cap.gbp !== undefined && g.used.gbp + spendGbp > g.cap.gbp)
    return { ok: false, gap: `spend cap reached: £${g.used.gbp.toFixed(2)} of £${g.cap.gbp.toFixed(2)}` };
  return { ok: true };
}

export function isLive(g: Grant, now: Date): boolean {
  return Date.parse(g.expiresAt) > now.getTime();
}

/**
 * Pure matcher: given the grants in force for a session and a check, decide.
 * Used verbatim by the local cache (hot path) and the policy service (ledger generation).
 */
export function matchGrants(grants: Grant[], c: PolicyCheck, now = new Date()): PolicyResult {
  const candidates = grants.filter((g) => g.action === c.tool && isLive(g, now));
  if (candidates.length === 0)
    return { decision: "park", reason: "no grant for this action", gap: `no grant for ${c.tool}` };

  let lastGap = "";
  for (const g of candidates) {
    const s = scopeMatches(g.scope, c);
    if (!s.ok) { lastGap = s.gap ?? ""; continue; }
    const r = hasRoom(g);
    if (!r.ok) { lastGap = r.gap ?? ""; continue; }
    return { decision: "allow", grantId: g.id, reason: "matched grant" };
  }
  return { decision: "park", reason: "grant exists but does not cover this call", gap: lastGap };
}
