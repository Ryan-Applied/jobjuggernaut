import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import type { Client } from "@temporalio/client";
import { ProjectDraft, WorkflowDraft } from "@jj/core";
import { ingestProject, ingestWorkflow, assessProject } from "@jj/workflows";

/**
 * LLM-assisted ingestion. Drafts are produced on the runner (files + key live there),
 * stored as `draft` nodes so you can review, edit and accept them from the UI.
 */
export function ingestRoutes(db: Db, temporal: Client) {
  const r = new Hono();

  r.post("/ingest/project", async (c) => {
    const body = z.object({ workdir: z.string().optional(), hint: z.string().optional(), runnerId: z.string().default("laptop") }).parse(await c.req.json());
    const draft = await ingestProject(temporal, body);
    const id = crypto.randomUUID();
    await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'draft', ${draft.title}, ${JSON.stringify({ kind: "project", status: "draft", workdir: body.workdir, hint: body.hint, runnerId: body.runnerId, draft })}::jsonb)`);
    return c.json({ draftId: id, draft });
  });

  r.post("/ingest/workflow", async (c) => {
    const body = z.object({ text: z.string().optional(), path: z.string().optional(), runnerId: z.string().default("laptop"), projectId: z.string().uuid().optional() }).parse(await c.req.json());
    if (!body.text && !body.path) return c.json({ error: "text or path required" }, 400);
    const draft = await ingestWorkflow(temporal, body);
    const id = crypto.randomUUID();
    await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'draft', ${draft.title}, ${JSON.stringify({ kind: "workflow", status: "draft", projectId: body.projectId, draft })}::jsonb)`);
    return c.json({ draftId: id, draft });
  });

  r.get("/drafts", async (c) => c.json({ drafts: await db.execute(sql`select id, title, props, created_at from nodes where type = 'draft' and props->>'status' = 'draft' order by created_at desc`) }));

  /** Accept: optionally with edits to the draft; creates the project or workflow (and chore if asked). */
  r.post("/drafts/:id/accept", async (c) => {
    const body = z.object({ edits: z.record(z.unknown()).optional(), createChore: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const [d] = (await db.execute(sql`select id, props from nodes where id = ${c.req.param("id")} and type = 'draft'`)) as any[];
    if (!d) return c.json({ error: "not found" }, 404);
    const merged = { ...d.props.draft, ...(body.edits ?? {}) };
    let createdId: string; let choreId: string | undefined;
    if (d.props.kind === "project") {
      const p = ProjectDraft.parse(merged);
      createdId = crypto.randomUUID();
      await db.execute(sql`insert into nodes (id, type, title, props) values (${createdId}, 'project', ${p.title}, ${JSON.stringify({ workdir: d.props.workdir, runnerId: d.props.runnerId ?? "laptop", goal: p.goal, summary: p.summary, defaultMode: p.defaultMode, continueSteps: p.continueSteps, grantTemplate: p.grantTemplate, skills: p.skills, connectors: p.connectors, epics: p.epics, risks: p.risks, evidence: p.evidence, ingestedAt: new Date().toISOString() })}::jsonb)`);
      for (const sk of p.skills) await ensureSkill(db, createdId, sk);
      if (body.createChore && p.suggestedChore) choreId = await createChoreViaApi(p.suggestedChore, { projectId: createdId });
    } else {
      const w = WorkflowDraft.parse(merged);
      createdId = crypto.randomUUID();
      await db.execute(sql`insert into nodes (id, type, title, props) values (${createdId}, 'workflow', ${w.title}, ${JSON.stringify({ description: w.description, steps: w.steps, grantTemplate: w.grantTemplate, projectId: d.props.projectId, evidence: w.evidence, ingestedAt: new Date().toISOString() })}::jsonb)`);
      for (const s of w.steps) for (const sk of s.skills) await ensureSkill(db, createdId, sk);
      if (body.createChore && w.suggestedChore) choreId = await createChoreViaApi(w.suggestedChore, { workflowId: createdId });
    }
    await db.execute(sql`update nodes set props = props || ${JSON.stringify({ status: "accepted", createdId, acceptedAt: new Date().toISOString() })}::jsonb where id = ${d.id}`);
    return c.json({ id: createdId, kind: d.props.kind, choreId });
  });
  r.post("/drafts/:id/reject", async (c) => { await db.execute(sql`update nodes set props = props || '{"status":"rejected"}'::jsonb where id = ${c.req.param("id")}`); return c.json({ ok: true }); });

  /** On-demand progress assessment (also runs automatically after every indexed session). */
  r.post("/projects/:id/assess", async (c) => c.json({ assessment: await assessProject(temporal, c.req.param("id")) }));

  async function createChoreViaApi(ch: { cron: string; mode: string }, target: { projectId?: string; workflowId?: string }) {
    const res = await fetch(`http://localhost:${process.env.API_PORT ?? 4000}/chores`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target, cron: ch.cron, mode: ch.mode }) });
    return ((await res.json()) as any).id as string | undefined;
  }
  return r;
}

async function ensureSkill(db: Db, ownerId: string, name: string) {
  const [skill] = (await db.execute(sql`select id from nodes where type = 'skill' and title = ${name} order by (props->>'version')::int desc nulls last limit 1`)) as any[];
  const sid = skill?.id ?? crypto.randomUUID();
  if (!skill) await db.execute(sql`insert into nodes (id, type, title, props) values (${sid}, 'skill', ${name}, '{"version":1}'::jsonb)`);
  await db.execute(sql`insert into edges (src, dst, type) values (${ownerId}, ${sid}, 'uses_skill') on conflict do nothing`);
}
