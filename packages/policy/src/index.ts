import type { Grant, PolicyCheck, PolicyResult } from "@jj/core";
import { findForbid } from "./forbid.js";
import { matchGrants } from "./matcher.js";

export * from "./forbid.js";
export * from "./matcher.js";

/** Forbid rules first (no grant overrides them), then grant matching. */
export function checkPolicy(grants: Grant[], c: PolicyCheck, now = new Date()): PolicyResult {
  const f = findForbid(c);
  if (f) return { decision: "deny", reason: `${f.id}: ${f.reason}` };
  return matchGrants(grants, c, now);
}

/** In-memory grant cache used by the runner daemon. Sub-millisecond by construction. */
export class GrantCache {
  private bySession = new Map<string, Grant[]>();
  load(sessionId: string, grants: Grant[]) { this.bySession.set(sessionId, grants); }
  grantsFor(sessionId: string) { return this.bySession.get(sessionId) ?? []; }
  check(c: PolicyCheck, now = new Date()): PolicyResult {
    const res = checkPolicy(this.grantsFor(c.sessionId), c, now);
    if (res.decision === "allow" && res.grantId) {
      const g = this.grantsFor(c.sessionId).find((x) => x.id === res.grantId);
      if (g) g.used.count += 1;
    }
    return res;
  }
  evict(sessionId: string) { this.bySession.delete(sessionId); }
}
