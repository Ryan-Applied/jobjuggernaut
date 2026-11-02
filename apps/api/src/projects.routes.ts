import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import type { Client } from "@temporalio/client";
import { startTask, goAhead, taskStatus, type TaskDefinition } from "@jj/workflows";
import { WorkflowDef } from "./graph.routes.js";
import { signedGrantIdsForTask, ledgerForTaskMode, persistLedger, nextExpiry } from "./ledgers.routes.js";
import { buildLedger } from "@jj/policy";

const Project = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  workdir: z.string().optional(),            // repo or folder on the runner host; absent => scratch
  runnerId: z.string().default("laptop"),
  defaultMode: z.enum(["auto", "assist", "manual"]).default("assist"),
  goal: z.string().optional(),
  grantTemplate: WorkflowDef.shape.grantTemplate,
  /** Default steps for "Continue": a single step whose prompt is the goal unless overridden. */
  continueSteps: WorkflowDef.shape.steps.optional(),
  tags: z.array(z.string()).default([]),
});

/** Destructive or outward actions park in assist mode even when the template allows them. */
export const OUTWARD = /^(git\.push|github\.|gh\.|slack\.post|gmail\.send|jira\.transition|notion\.(create|update|delete)|confluence\.(create|update)|Write$|Bash$)/;

export function projectRoutes(db: Db, temporal: Client) {
  const r = new Hono();

  r.get("/projects", async (c) => {
    const rows = await db.execute(sql`
      select p.id, p.title, p.props, p.created_at,
        (select row_to_json(s) from (select s.id, s.title, s.props, s.created_at from nodes s where s.type = 'session' and s.props->>'projectId' = p.id::text order by s.created_at desc limit 1) s) as last_session,
        (select count(*) from nodes s where s.type = 'session' and s.props->>'projectId' = p.id::text and s.props->>'state' in ('running','starting'))::int as running,
        (select count(*) from nodes s where s.type = 'session' and s.props->>'projectId' = p.id::text and s.props->>'state' = 'parked')::int as parked,
        (select count(*) from nodes t where t.type = 'task' and t.props->>'projectId' = p.id::text and t.props->>'state' = 'awaiting_go_ahead')::int as awaiting,
        (select coalesce(sum((s.props->>'spendGbp')::numeric),0) from nodes s where s.type = 'session' and s.props->>'projectId' = p.id::text and s.created_at > now() - interval '24 hours') as spend_24h,
        (select count(*) from nodes s where s.type = 'session' and s.props->>'projectId' = p.id::text)::int as sessions
      from nodes p where p.type = 'project' order by p.created_at`);
    return c.json({ projects: rows });
  });

  r.post("/projects", async (c) => {
    const p = Project.parse(await c.req.json());
    const id = p.id ?? crypto.randomUUID();
    const props = { ...p, id: undefined, title: undefined };
    await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'project', ${p.title}, ${JSON.stringify(props)}::jsonb)
      on conflict (id) do update set title = excluded.title, props = nodes.props || excluded.props, updated_at = now()`);
    return c.json({ id });
  });

  r.get("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const [p] = (await db.execute(sql`select id, title, props, created_at from nodes where id = ${id} and type = 'project'`)) as any[];
    if (!p) return c.json({ error: "not found" }, 404);
    const sessions = await db.execute(sql`select id, title, props, created_at from nodes where type = 'session' and props->>'projectId' = ${id} order by created_at desc limit 30`);
    const tasks = await db.execute(sql`select id, title, props, created_at from nodes where type = 'task' and props->>'projectId' = ${id} order by created_at desc limit 20`);
    const derived = await db.execute(sql`select n.id, n.title, n.type, e.props from edges e join nodes n on n.id = e.dst where e.src = ${id} and e.type = 'derived_from'`);
    return c.json({ project: p, sessions, tasks, derived });
  });

  /**
   * Continue a project: build a task from the project's continue steps (or an ad hoc prompt),
   * compute grants for the chosen mode, start now or queue for tonight.
   * Optional `from`: session ids from other projects whose steps/lessons are folded into the pack.
   */
  const Continue = z.object({
    mode: z.enum(["auto", "assist", "manual"]).optional(),
    prompt: z.string().optional(),
    steps: WorkflowDef.shape.steps.optional(),
    from: z.array(z.string().uuid()).default([]),
    scheduledFor: z.string().datetime().optional(),
    runnerId: z.string().optional(),
  });
  r.post("/projects/:id/continue", async (c) => {
    const id = c.req.param("id");
    const body = Continue.parse(await c.req.json());
    const [p] = (await db.execute(sql`select id, title, props from nodes where id = ${id} and type = 'project'`)) as any[];
    if (!p) return c.json({ error: "not found" }, 404);
    const mode = body.mode ?? p.props.defaultMode ?? "assist";
    const steps = body.steps ?? (body.prompt ? [{ name: "continue", prompt: body.prompt, skills: [], connectors: [], intendedActions: [], maxCostGbp: 5 }] : p.props.continueSteps) ?? [{ name: "continue", prompt: p.props.goal ?? "Continue the project.", skills: [], connectors: [], intendedActions: [], maxCostGbp: 5 }];

    // Pull in other sessions: their lessons and prompts become part of the context, and a derived_from edge is recorded.
    let imported = "";
    for (const sid of body.from) {
      const [s] = (await db.execute(sql`select id, title, props from nodes where id = ${sid}`)) as any[];
      if (!s) continue;
      imported += `\n## Brought in from "${s.title}"\nPrompt: ${s.props.prompt ?? ""}\n${(s.props.lessons ?? []).map((l: string) => `- ${l}`).join("\n")}\n`;
      await db.execute(sql`insert into edges (src, dst, type, props) values (${id}, ${sid}, 'derived_from', ${JSON.stringify({ at: new Date().toISOString() })}::jsonb) on conflict do nothing`);
    }

    const taskId = crypto.randomUUID();
    const workflowId = p.props.workflowId ?? (await ensureWorkflow(db, p));
    const def: TaskDefinition = {
      taskId, workflowId, projectId: id, title: `${p.title}: ${steps[0].name}`, steps, grantIds: [], runnerId: body.runnerId ?? p.props.runnerId ?? "laptop",
      mode, projectWorkdir: p.props.workdir, context: imported || undefined,
    };
    await db.execute(sql`insert into nodes (id, type, title, props) values (${taskId}, 'task', ${def.title}, ${JSON.stringify({ steps, runnerId: def.runnerId, workflowId, projectId: id, mode, projectWorkdir: p.props.workdir, scheduledFor: body.scheduledFor, state: body.scheduledFor ? "queued" : "starting", from: body.from })}::jsonb)`);
    await db.execute(sql`insert into edges (src, dst, type) values (${taskId}, ${id}, 'belongs_to') on conflict do nothing`);

    // Now: ledger for the mode (auto/assist signed from the template; manual none).
    // Tonight: a draft you sign under Approvals, unless the project opts into auto-signing its template.
    if (body.scheduledFor) {
      if (mode === "manual") return c.json({ taskId, queued: true, needsSignature: false });
      if (p.props.autoSignTemplate) { const l = await ledgerForTaskMode(db, taskId, mode, steps, p.props.grantTemplate ?? []); return c.json({ taskId, queued: true, ledgerId: l?.id, needsSignature: false }); }
      const l = buildLedger({ taskId, steps, template: p.props.grantTemplate ?? [], expiresAt: nextExpiry() });
      if (mode === "assist") l.grants = l.grants.filter((g) => !OUTWARD.test(g.action));
      await persistLedger(db, l);
      return c.json({ taskId, queued: true, ledgerId: l.id, needsSignature: true });
    }
    const ledger = await ledgerForTaskMode(db, taskId, mode, steps, p.props.grantTemplate ?? []);
    def.grantIds = ledger?.status === "signed" ? await signedGrantIdsForTask(db, taskId) : [];
    const h = await startTask(temporal, def);
    return c.json({ taskId, workflowRunId: h.firstExecutionRunId, mode, grants: def.grantIds.length });
  });

  r.post("/tasks/:id/go", async (c) => {
    const body = z.object({ stepIndex: z.number().int(), go: z.boolean().default(true) }).parse(await c.req.json());
    await goAhead(temporal, c.req.param("id"), body.stepIndex, body.go);
    return c.json({ ok: true });
  });
  r.get("/tasks/:id/status", async (c) => { try { return c.json(await taskStatus(temporal, c.req.param("id"))); } catch { return c.json({ state: "unknown" }, 404); } });
  r.get("/tasks", async (c) => {
    const state = c.req.query("state");
    const rows = await db.execute(state
      ? sql`select id, title, props, created_at from nodes where type = 'task' and props->>'state' = ${state} order by created_at desc limit 100`
      : sql`select id, title, props, created_at from nodes where type = 'task' order by created_at desc limit 100`);
    return c.json({ tasks: rows });
  });
  return r;
}

async function ensureWorkflow(db: Db, p: any): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'workflow', ${`${p.title} continue`}, ${JSON.stringify({ steps: p.props.continueSteps ?? [], grantTemplate: p.props.grantTemplate ?? [], projectId: p.id })}::jsonb)`);
  await db.execute(sql`update nodes set props = props || ${JSON.stringify({ workflowId: id })}::jsonb where id = ${p.id}`);
  return id;
}
