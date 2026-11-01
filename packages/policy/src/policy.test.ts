import { describe, it, expect } from "vitest";
import { checkPolicy, GrantCache } from "./index.js";
import type { Grant } from "@jj/core";

const later = new Date(Date.now() + 3600_000).toISOString();
const sid = "11111111-1111-4111-8111-111111111111";
const push: Grant = {
  id: "22222222-2222-4222-8222-222222222222", ledgerId: "33333333-3333-4333-8333-333333333333",
  action: "git.push", scope: { repo: ["applied/atlas"], branch: "chore/*" },
  cap: { count: 2 }, used: { count: 0, gbp: 0 }, expiresAt: later, delegated: false,
};

describe("checkPolicy", () => {
  it("allows a call inside scope", () => {
    const r = checkPolicy([push], { sessionId: sid, tool: "git.push", args: { repo: "applied/atlas", branch: "chore/deps" }, resource: {} });
    expect(r.decision).toBe("allow");
  });
  it("parks a call outside scope with a readable gap", () => {
    const r = checkPolicy([push], { sessionId: sid, tool: "git.push", args: { repo: "applied/atlas", branch: "main" }, resource: {} });
    expect(r.decision).toBe("park");
    expect(r.gap).toContain("chore/*");
  });
  it("parks when no grant exists", () => {
    const r = checkPolicy([push], { sessionId: sid, tool: "slack.post", args: { channel: "#x" }, resource: {} });
    expect(r.decision).toBe("park");
  });
  it("denies forbidden actions regardless of grants", () => {
    const r = checkPolicy([push], { sessionId: sid, tool: "jira.transition", args: { toStatus: "Closed" }, resource: {} });
    expect(r.decision).toBe("deny");
  });
  it("cache counts usage and parks at cap", () => {
    const c = new GrantCache();
    c.load(sid, [structuredClone(push)]);
    const call = { sessionId: sid, tool: "git.push", args: { repo: "applied/atlas", branch: "chore/a" }, resource: {} };
    expect(c.check(call).decision).toBe("allow");
    expect(c.check(call).decision).toBe("allow");
    const third = c.check(call);
    expect(third.decision).toBe("park");
    expect(third.gap).toContain("cap reached");
  });
});
