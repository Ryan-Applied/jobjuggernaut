import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import { nodes, addEdge } from "@jj/graph";
import type { SessionEvent } from "@jj/core";
import { defaultEmbedder, type Embedder } from "./embed.js";
import { summarise, lessons, type SessionSummary } from "./summary.js";

export * from "./embed.js";
export * from "./summary.js";

const SIMILAR_THRESHOLD = Number(process.env.JJ_SIMILAR_THRESHOLD ?? 0.80);

export interface IndexResult { sessionId: string; similar: Array<{ id: string; score: number }>; lessons: string[]; edges: number }

async function ensureNode(db: Db, type: string, title: string, props: Record<string, unknown> = {}): Promise<string> {
  const rows = await db.execute(sql`select id from nodes where type = ${type} and title = ${title} limit 1`);
  if (rows.length) return (rows[0] as any).id;
  const id = crypto.randomUUID();
  await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, ${type}, ${title}, ${JSON.stringify(props)}::jsonb)`);
  return id;
}

/** Turn a finished session into graph structure. Idempotent. */
export async function indexSession(db: Db, sessionId: string, embedder: Embedder = defaultEmbedder()): Promise<IndexResult> {
  const [node] = (await db.execute(sql`select id, title, props from nodes where id = ${sessionId}`)) as any[];
  if (!node) throw new Error(`no session node ${sessionId}`);
  const rows = (await db.execute(sql`select payload from session_events where session_id = ${sessionId} order by seq`)) as any[];
  const events = rows.map((r) => r.payload as SessionEvent);
  const summary = summarise(events, { ...node.props, title: node.title });

  // 1. embed
  const vec = await embedder.embed(summary.text);
  await db.execute(sql`update nodes set embedding = ${`[${vec.join(",")}]`}::vector, updated_at = now() where id = ${sessionId}`);

  // 2. nearest sessions -> similar_to (symmetric)
  const near = (await db.execute(sql`
    select id, props, 1 - (embedding <=> (select embedding from nodes where id = ${sessionId})) as score
    from nodes where type = 'session' and id <> ${sessionId} and embedding is not null
    order by embedding <=> (select embedding from nodes where id = ${sessionId}) limit 20`)) as any[];
  const similar = near.filter((n) => Number(n.score) >= SIMILAR_THRESHOLD).map((n) => ({ id: n.id as string, score: Number(n.score) }));
  let edges = 0;
  for (const s of similar) { await addEdge(db, sessionId, s.id, "similar_to", s.score); await addEdge(db, s.id, sessionId, "similar_to", s.score); edges += 2; }

  // 3. structural edges
  if (summary.workflowId) { await addEdge(db, sessionId, summary.workflowId, "part_of").catch(() => undefined); edges++; }
  if (summary.taskId) { await addEdge(db, sessionId, summary.taskId, "part_of").catch(() => undefined); edges++; }
  for (const [conn, n] of Object.entries(summary.connectors)) { await addEdge(db, sessionId, await ensureNode(db, "connector", conn), "touched", n); edges++; }
  for (const skill of (node.props.skills ?? []) as string[]) { await addEdge(db, sessionId, await ensureNode(db, "skill", skill, { version: 1 }), "uses_skill"); edges++; }
  if (summary.runnerId) { await addEdge(db, sessionId, await ensureNode(db, "runner", summary.runnerId), "ran_on"); edges++; }
  for (const g of (node.props.grantIds ?? []) as string[]) { await addEdge(db, sessionId, g, "authorised_by").catch(() => undefined); }
  for (const p of summary.parked) {
    const approvalId = await ensureNode(db, "approval", `${sessionId.slice(0, 8)} ${p.tool}`, { sessionId, tool: p.tool, gap: p.gap, resolved: p.resolved });
    await addEdge(db, sessionId, approvalId, "required_approval"); edges++;
  }
  for (const a of summary.artifacts) { await addEdge(db, sessionId, await ensureNode(db, "artifact", a.title || a.uri, a), "produced"); edges++; }
  // C4: sub-agents become child session nodes with a spawned edge
  const subs = new Map<string, { calls: number; messages: number }>();
  for (const e of events) { const sid = (e as any).subagentId as string | undefined; if (!sid) continue; const cur = subs.get(sid) ?? { calls: 0, messages: 0 }; if (e.type === "tool_call") cur.calls++; if (e.type === "message") cur.messages++; subs.set(sid, cur); }
  for (const [sid, st] of subs) {
    const childId = await ensureNode(db, "session", `${node.title}: sub-agent ${sid.slice(0, 6)}`, { parentSessionId: sessionId, subagentId: sid, state: "done", outcome: "complete", projectId: node.props.projectId, workflowId: node.props.workflowId, taskId: node.props.taskId, ...st });
    await addEdge(db, sessionId, childId, "spawned", st.calls); edges++;
  }

  // 4. lessons from this run + its neighbours
  const neighbourSummaries: SessionSummary[] = [];
  for (const s of similar.slice(0, 3)) {
    const ev = (await db.execute(sql`select payload from session_events where session_id = ${s.id} order by seq`)) as any[];
    const [nn] = (await db.execute(sql`select title, props from nodes where id = ${s.id}`)) as any[];
    neighbourSummaries.push(summarise(ev.map((r) => r.payload), { ...nn.props, title: nn.title }));
  }
  const ls = lessons(summary, neighbourSummaries);
  await db.execute(sql`update nodes set props = props || ${JSON.stringify({ summary: { ...summary, text: undefined }, lessons: ls, indexedAt: new Date().toISOString(), embedder: embedder.name })}::jsonb where id = ${sessionId}`);
  return { sessionId, similar, lessons: ls, edges };
}

/**
 * Nightly per-workflow pass: proposals to add/remove grants and edit skills.
 * Proposals are nodes of type "proposal" with props.status = proposed. Accepting one is Phase 4 UI.
 */
/** D3: accept/reject history per proposal kind; kinds you keep rejecting are suppressed. */
export async function proposalStats(db: Db): Promise<Record<string, { accepted: number; rejected: number; suppressed: boolean }>> {
  const rows = (await db.execute(sql`select props->>'kind' as kind, props->>'status' as status, count(*)::int as n from nodes where type = 'proposal' and props->>'status' in ('accepted','rejected') group by 1, 2`)) as any[];
  const out: Record<string, { accepted: number; rejected: number; suppressed: boolean }> = {};
  for (const r of rows) { const k = out[r.kind] ??= { accepted: 0, rejected: 0, suppressed: false }; if (r.status === "accepted") k.accepted += r.n; else k.rejected += r.n; }
  for (const k of Object.values(out)) k.suppressed = k.accepted + k.rejected >= 5 && k.rejected / (k.accepted + k.rejected) >= 0.8;
  return out;
}

/** D5: drop raw events older than the retention window for sessions that already carry a summary. Nodes and edges stay. */
export async function compactEvents(db: Db, retentionDays = Number(process.env.JJ_EVENT_RETENTION_DAYS ?? 180)): Promise<number> {
  const r = (await db.execute(sql`
    with old as (select id from nodes where type = 'session' and props ? 'summary' and created_at < now() - (${retentionDays} || ' days')::interval)
    delete from session_events where session_id in (select id from old) and type not in ('started','done','error','approval_request','cost')`)) as any;
  return Number(r?.count ?? 0);
}

export async function proposeForWorkflow(db: Db, workflowId: string): Promise<string[]> {
  const stats = await proposalStats(db);
  const allowed = (kind: string) => !stats[kind]?.suppressed;
  const sessions = (await db.execute(sql`
    select n.id, n.props from edges e join nodes n on n.id = e.src
    where e.dst = ${workflowId} and e.type = 'part_of' and n.type = 'session' and n.props ? 'summary'
    order by n.created_at desc limit 10`)) as any[];
  if (!sessions.length) return [];
  const created: string[] = [];
  const parkedCounts: Record<string, { n: number; gap: string }> = {};
  for (const s of sessions) for (const p of s.props.summary.parked ?? []) {
    if (p.resolved !== "approved") continue;
    parkedCounts[p.tool] = { n: (parkedCounts[p.tool]?.n ?? 0) + 1, gap: p.gap };
  }
  for (const [tool, { n, gap }] of Object.entries(parkedCounts)) if (n >= 3 && allowed("add_grant")) {
    created.push(await upsertProposal(db, workflowId, "add_grant", `Add ${tool} to the grant template`, { tool, gap, evidence: n, of: sessions.length }));
  }
  // unused grants: compare template to actually-used tools across the last 5 runs
  const [wf] = (await db.execute(sql`select props from nodes where id = ${workflowId}`)) as any[];
  const template: Array<{ action: string }> = wf?.props?.grantTemplate ?? [];
  const used = new Set(sessions.slice(0, 5).flatMap((s) => Object.keys(s.props.summary.tools ?? {})));
  for (const g of template) if (!used.has(g.action) && sessions.length >= 5 && allowed("remove_grant")) {
    created.push(await upsertProposal(db, workflowId, "remove_grant", `Remove unused ${g.action} from the grant template`, { tool: g.action, evidence: 0, of: 5 }));
  }
  // recurring lessons -> skill edit proposal
  const lessonCounts: Record<string, number> = {};
  for (const s of sessions) for (const l of s.props.lessons ?? []) lessonCounts[l] = (lessonCounts[l] ?? 0) + 1;
  const recurring = Object.entries(lessonCounts).filter(([, n]) => n >= 3).map(([l]) => l);
  if (recurring.length && allowed("skill_edit")) created.push(await upsertProposal(db, workflowId, "skill_edit", "Fold recurring lessons into the skill", { lessons: recurring }));
  return created;
}

async function upsertProposal(db: Db, workflowId: string, kind: string, title: string, props: Record<string, unknown>) {
  const existing = (await db.execute(sql`
    select id from nodes where type = 'proposal' and props->>'workflowId' = ${workflowId} and props->>'kind' = ${kind} and props->>'title' = ${title}
      and (props->>'status' = 'proposed' or (props->>'status' = 'rejected' and (props->>'decidedAt')::timestamptz > now() - interval '30 days')) limit 1`)) as any[];
  if (existing.length) return existing[0].id as string;
  const id = crypto.randomUUID();
  await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'proposal', ${title}, ${JSON.stringify({ ...props, kind, title, workflowId, status: "proposed" })}::jsonb)`);
  await addEdge(db, id, workflowId, "part_of");
  return id;
}
