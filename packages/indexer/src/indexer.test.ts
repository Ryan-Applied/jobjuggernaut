import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, appendEvents } from "@jj/graph";
import type { SessionEvent } from "@jj/core";
import { indexSession, proposeForWorkflow, HashEmbedder } from "./index.js";

const { db } = createDb(process.env.DATABASE_URL ?? "postgres://jj:jj@127.0.0.1:5432/jj");
const WF = crypto.randomUUID();
const ts = (i: number) => new Date(Date.now() + i * 1000).toISOString();

function session(prompt: string, tools: string[], parked = false): { id: string; events: SessionEvent[] } {
  const id = crypto.randomUUID(); let seq = 0;
  const ev: SessionEvent[] = [
    { type: "started", sessionId: id, seq: seq++, ts: ts(0), runnerId: "laptop", vendor: "claude", vendorSessionRef: "x", workdir: "/tmp" },
    { type: "message", sessionId: id, seq: seq++, ts: ts(1), role: "assistant", text: prompt, tokensIn: 10, tokensOut: 10 },
  ];
  for (const t of tools) {
    const callId = `c${seq}`;
    ev.push({ type: "tool_call", sessionId: id, seq: seq++, ts: ts(2), callId, tool: t, args: {}, policyDecision: parked ? "park" : "allow" });
    if (parked) ev.push({ type: "approval_request", sessionId: id, seq: seq++, ts: ts(2), callId, tool: t, args: {}, grantGap: `no grant for ${t}` });
    ev.push({ type: "tool_result", sessionId: id, seq: seq++, ts: ts(3), callId, ok: true, summary: "ok", bytes: 2 });
  }
  ev.push({ type: "cost", sessionId: id, seq: seq++, ts: ts(4), tokensIn: 100, tokensOut: 50, costGbp: 0.5, cumulativeGbp: 0.5 });
  ev.push({ type: "done", sessionId: id, seq: seq++, ts: ts(5), outcome: "complete", summary: "done" });
  return { id, events: ev };
}

async function seed(s: { id: string; events: SessionEvent[] }, title: string) {
  await db.execute(sql`insert into nodes (id, type, title, props) values (${s.id}, 'session', ${title}, ${JSON.stringify({ workflowId: WF, prompt: title, skills: ["jira-monday-triage"] })}::jsonb)`);
  await appendEvents(db, s.events);
}

describe("indexer against Postgres + pgvector", () => {
  const a = session("Monday Jira triage: review open SEC tickets and comment", ["jira.search", "jira.addComment", "confluence.getPage"], true);
  const b = session("Monday Jira triage: review open SEC tickets and comment carryover", ["jira.search", "jira.addComment", "confluence.getPage"], true);
  const c = session("Monday Jira triage: review open SEC tickets, comment, escalate", ["jira.search", "jira.addComment", "confluence.getPage"], true);
  const d = session("Write a landing page in React with Tailwind for a bakery", ["Write", "Bash"]);

  beforeAll(async () => {
    await db.execute(sql`insert into nodes (id, type, title, props) values (${WF}, 'workflow', 'Monday triage', ${JSON.stringify({ grantTemplate: [{ action: "slack.post" }, { action: "jira.search" }] })}::jsonb)`);
    for (const [s, t] of [[a, "triage 1"], [b, "triage 2"], [c, "triage 3"], [d, "bakery page"]] as const) await seed(s, t);
  });

  it("embeds, links similar sessions, writes structural edges and lessons", async () => {
    const e = new HashEmbedder();
    await indexSession(db, a.id, e); await indexSession(db, b.id, e); await indexSession(db, d.id, e);
    const r = await indexSession(db, c.id, e);
    expect(r.similar.map((s) => s.id)).toContain(a.id);
    expect(r.similar.map((s) => s.id)).toContain(b.id);
    expect(r.similar.map((s) => s.id)).not.toContain(d.id);
    const edges = (await db.execute(sql`select type, count(*)::int as n from edges where src = ${c.id} group by type`)) as any[];
    const byType = Object.fromEntries(edges.map((x) => [x.type, x.n]));
    expect(byType.similar_to).toBeGreaterThanOrEqual(2);
    expect(byType.touched).toBe(2);           // jira, confluence
    expect(byType.uses_skill).toBe(1);
    expect(byType.required_approval).toBe(3);
    expect(byType.part_of).toBe(1);
    expect(r.lessons.some((l) => l.includes("parked in"))).toBe(true);
  });

  it("proposes grant additions and removals for the workflow", async () => {
    const ids = await proposeForWorkflow(db, WF);
    const props = (await db.execute(sql`select props from nodes where type = 'proposal' and props->>'workflowId' = ${WF}`)) as any[];
    const kinds = props.map((p) => p.props.kind);
    expect(kinds).toContain("add_grant");           // jira.search approved-after-park in 3 runs
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // idempotent
    const again = await proposeForWorkflow(db, WF);
    expect(again.sort()).toEqual(ids.sort());
  });
});
