import { sql } from "drizzle-orm";
import type { Db } from "./db.js";
import type { SessionEvent } from "@jj/core";
import { nodes, edges, sessionEvents, auditLog } from "./schema.js";

/** Nearest sessions by stored similar_to edges, then by live cosine distance if no edges yet. */
export async function similarSessions(db: Db, sessionId: string, limit = 5) {
  const viaEdges = await db.execute(sql`
    select n.id, n.title, n.props, e.weight
    from edges e join nodes n on n.id = e.dst
    where e.src = ${sessionId} and e.type = 'similar_to'
    order by e.weight desc limit ${limit}`);
  if (viaEdges.length) return viaEdges;
  return db.execute(sql`
    select n.id, n.title, n.props, 1 - (n.embedding <=> s.embedding) as weight
    from nodes s, nodes n
    where s.id = ${sessionId} and n.type = 'session' and n.id <> s.id
      and s.embedding is not null and n.embedding is not null
    order by n.embedding <=> s.embedding limit ${limit}`);
}

/** Every session that is part_of a workflow, newest first. */
export async function workflowRuns(db: Db, workflowId: string, limit = 20) {
  return db.execute(sql`
    select n.id, n.title, n.props, n.created_at
    from edges e join nodes n on n.id = e.src
    where e.dst = ${workflowId} and e.type = 'part_of' and n.type = 'session'
    order by n.created_at desc limit ${limit}`);
}

/** One-hop neighbourhood grouped by edge type, for the graph explorer. */
export async function neighbourhood(db: Db, nodeId: string) {
  return db.execute(sql`
    select e.type as edge, e.weight, n.id, n.type, n.title
    from edges e join nodes n on n.id = case when e.src = ${nodeId} then e.dst else e.src end
    where e.src = ${nodeId} or e.dst = ${nodeId}
    order by e.type, e.weight desc nulls last`);
}

export async function upsertSessionNode(db: Db, sessionId: string, title: string, props: Record<string, unknown>) {
  await db.insert(nodes).values({ id: sessionId, type: "session", title, props })
    .onConflictDoUpdate({ target: nodes.id, set: { props: sql`${nodes.props} || ${JSON.stringify(props)}::jsonb`, updatedAt: sql`now()` } });
}

export async function appendEvents(db: Db, batch: SessionEvent[]) {
  if (!batch.length) return;
  await db.insert(sessionEvents).values(batch.map((e) => ({
    sessionId: e.sessionId, seq: e.seq, ts: new Date(e.ts), type: e.type, payload: e,
  }))).onConflictDoNothing();
}

export async function recordDecision(db: Db, row: { sessionId: string; tool: string; argsHash: string; decision: string; grantId?: string; decidedBy: string; payload?: unknown }) {
  await db.insert(auditLog).values({ ...row, payload: row.payload ?? null });
}

export async function addEdge(db: Db, src: string, dst: string, type: string, weight?: number, props: Record<string, unknown> = {}) {
  await db.insert(edges).values({ src, dst, type, weight, props }).onConflictDoUpdate({ target: [edges.src, edges.dst, edges.type], set: { weight, props } });
}
