import { describe, it, expect } from "vitest";
import { buildLedger, signLedger, verifyLedger, grantForGap, dryRun, type StepDef } from "./ledger.js";

const expiresAt = new Date(Date.now() + 8 * 3600_000).toISOString();
const steps: StepDef[] = [
  { name: "collect", maxCostGbp: 2, intendedActions: [{ tool: "jira.search", cap: { count: 20 } }, { tool: "confluence.getPage", cap: { count: 10 } }] },
  { name: "act", maxCostGbp: 1, intendedActions: [{ tool: "slack.post", scope: { channel: "#product-shared" } }, { tool: "gmail.send", scope: { to: "x@external.com" } }, { tool: "jira.transition", scope: { toStatus: "Closed" } }, { tool: "git.push", scope: { repo: "applied/atlas", branch: "chore/*" }, cap: { count: 5 } }] },
];

describe("ledger", () => {
  it("dry run merges template and steps and adds a spend cap", () => {
    const d = dryRun(steps, [{ action: "jira.search", cap: { count: 5 } }]);
    expect(d.find((a) => a.tool === "jira.search")!.cap!.count).toBe(25);
    expect(d.find((a) => a.tool === "spend")!.cap!.gbp).toBe(3.3);
  });
  it("splits grants from never-pre-authorised rows", () => {
    const l = buildLedger({ taskId: crypto.randomUUID(), steps, expiresAt });
    expect(l.grants.map((g) => g.action).sort()).toEqual(["confluence.getPage", "git.push", "jira.search", "spend"]);
    expect(l.neverPreAuthorised.map((n) => n.action).sort()).toEqual(["gmail.send", "jira.transition", "slack.post"]);
  });
  it("signs and detects tampering", () => {
    const l = buildLedger({ taskId: crypto.randomUUID(), steps, expiresAt });
    const sig = signLedger(l, "secret");
    expect(verifyLedger(l, sig, "secret")).toBe(true);
    l.grants[0].cap = { count: 999 };
    expect(verifyLedger(l, sig, "secret")).toBe(false);
  });
  it("widening creates a delegated grant scoped to the gap", () => {
    const g = grantForGap(crypto.randomUUID(), "slack.post", { channel: "#sales-emea", text: "hi" }, expiresAt);
    expect(g.delegated).toBe(true); expect(g.scope).toEqual({ channel: "#sales-emea" }); expect(g.cap.count).toBe(5);
  });
});
