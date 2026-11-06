import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@jj/core";
import { HashEmbedder } from "./embed.js";
import { lessons, summarise } from "./summary.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const callId = "call-1";

function sampleEvents(): SessionEvent[] {
  const base = { sessionId, ts: "2026-11-06T00:00:00.000Z" };
  return [
    { ...base, seq: 0, type: "started", runnerId: "laptop", vendor: "openai", vendorSessionRef: "openai-1", workdir: "/work" },
    { ...base, ts: "2026-11-06T00:00:01.000Z", seq: 1, type: "tool_call", callId, tool: "jira.search", args: {}, policyDecision: "park" },
    { ...base, ts: "2026-11-06T00:00:02.000Z", seq: 2, type: "approval_request", callId, tool: "jira.search", args: {}, grantGap: "needs approval" },
    { ...base, ts: "2026-11-06T00:00:03.000Z", seq: 3, type: "tool_result", callId, ok: true, summary: "found issues", bytes: 20 },
    { ...base, ts: "2026-11-06T00:00:04.000Z", seq: 4, type: "cost", tokensIn: 10, tokensOut: 5, costGbp: 0.1, cumulativeGbp: 0.1 },
    { ...base, ts: "2026-11-06T00:00:05.000Z", seq: 5, type: "artifact", kind: "file", uri: "/work/report.md", title: "report.md" },
    { ...base, ts: "2026-11-06T00:00:06.000Z", seq: 6, type: "done", outcome: "complete", summary: "finished" },
  ];
}

describe("indexer summaries and embeddings", () => {
  it("builds a normalized deterministic hash embedding", async () => {
    const embedder = new HashEmbedder();
    const [first, repeat, lowercase] = await Promise.all([
      embedder.embed("Review Jira tickets"),
      embedder.embed("Review Jira tickets"),
      embedder.embed("review jira tickets"),
    ]);

    expect(first).toHaveLength(1024);
    expect(first).toEqual(repeat);
    expect(first).toEqual(lowercase);
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
  });

  it("summarizes tools, approvals, costs, artifacts, and completion", () => {
    const summary = summarise(sampleEvents(), { prompt: "Review Jira tickets", workflowId: "workflow-1" });

    expect(summary).toMatchObject({
      prompt: "Review Jira tickets",
      workflowId: "workflow-1",
      vendor: "openai",
      runnerId: "laptop",
      outcome: "complete",
      durationMs: 6000,
      tokensIn: 10,
      tokensOut: 5,
      costGbp: 0.1,
      connectors: { jira: 1 },
      tools: { "jira.search": 1 },
      parked: [{ tool: "jira.search", gap: "needs approval", resolved: "approved" }],
      artifacts: [{ kind: "file", uri: "/work/report.md", title: "report.md" }],
    });
    expect(summary.text).toContain("task: Review Jira tickets");
    expect(lessons(summary, [])).toEqual([
      "Needed approval for jira.search (needs approval); it was approved. Candidate for the grant template.",
    ]);
  });
});
