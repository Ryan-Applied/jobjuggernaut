import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import { ScheduleOverlapPolicy, type Client } from "@temporalio/client";
import { CLOUD_QUEUE } from "@jj/workflows";

/**
 * Chores are Temporal Schedules. Each fire runs a ChoreTick activity via a tiny
 * workflow? No: simpler and robust, the schedule starts TaskWorkflow directly with
 * a TaskDefinition snapshot taken at schedule time, and the API refreshes the
 * snapshot whenever the project/workflow changes. Standing system schedules
 * (overnight batch at 22:00, nightly learn at 03:00) are created on boot.
 */
const Chore = z.object({
  projectId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  cron: z.string(),                        // standard 5-field cron, local time zone below
  tz: z.string().default(process.env.JJ_TZ ?? "Europe/London"),
  mode: z.enum(["auto", "assist", "manual"]).default("auto"),
  runnerId: z.string().optional(),
  title: z.string().optional(),
  timeoutMinutes: z.number().int().positive().default(180),
});

export async function ensureSystemSchedules(temporal: Client) {
  const tz = process.env.JJ_TZ ?? "Europe/London";
  const defs = [
    { id: "sys-overnight-batch", cron: process.env.JJ_OVERNIGHT_CRON ?? "0 22 * * *", workflowType: "OvernightBatchWorkflow", args: [{ until: "+12h" }] },
    { id: "sys-nightly-learn", cron: process.env.JJ_LEARN_CRON ?? "0 3 * * *", workflowType: "NightlyLearnWorkflow", args: [] },
  ];
  for (const d of defs) {
    try {
      await temporal.schedule.create({
        scheduleId: d.id,
        spec: { cronExpressions: [d.cron], timezone: tz },
        action: { type: "startWorkflow", workflowType: d.workflowType, taskQueue: CLOUD_QUEUE, args: d.args, workflowId: `${d.id}-run` },
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      });
      console.log(`[api] schedule ${d.id} created (${d.cron} ${tz})`);
    } catch (e) { if (!String(e).includes("already")) console.error("[api] schedule", d.id, e); }
  }
}

export function choreRoutes(db: Db, temporal: Client) {
  const r = new Hono();

  r.get("/chores", async (c) => {
    const rows = (await db.execute(sql`select ch.id, ch.title, ch.props, ch.created_at, p.title as project, w.title as workflow from nodes ch
      left join nodes p on p.id::text = ch.props->>'projectId' left join nodes w on w.id::text = ch.props->>'workflowId' where ch.type = 'chore' order by ch.created_at`)) as any[];
    const out = [];
    for (const ch of rows) {
      let next: string | undefined, last: string | undefined;
      try { const d = await temporal.schedule.getHandle(`chore-${ch.id}`).describe(); next = d.info.nextActionTimes?.[0]?.toISOString(); last = d.info.recentActions?.at(-1)?.takenAt?.toISOString(); } catch {}
      out.push({ ...ch, next, last });
    }
    return c.json({ chores: out });
  });

  r.post("/chores", async (c) => {
    const body = Chore.parse(await c.req.json());
    if (!body.projectId && !body.workflowId) return c.json({ error: "projectId or workflowId required" }, 400);
    const [src] = (await db.execute(sql`select id, type, title, props from nodes where id = ${body.projectId ?? body.workflowId}`)) as any[];
    if (!src) return c.json({ error: "project/workflow not found" }, 404);
    const steps = src.type === "project" ? (src.props.continueSteps ?? [{ name: "continue", prompt: src.props.goal ?? "Continue.", skills: [], connectors: [], intendedActions: [], maxCostGbp: 5 }]) : src.props.steps;
    const id = crypto.randomUUID();
    const title = body.title ?? `${src.title} (${body.cron})`;
    const def = { taskId: id, workflowId: src.type === "project" ? (src.props.workflowId ?? body.workflowId ?? src.id) : src.id, projectId: src.type === "project" ? src.id : src.props.projectId, title, steps, grantIds: [], runnerId: body.runnerId ?? src.props.runnerId ?? "laptop", mode: body.mode, projectWorkdir: src.props.workdir };
    await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'chore', ${title}, ${JSON.stringify({ ...body, def, paused: false, autoSign: body.mode === "auto" })}::jsonb)`);
    if (def.projectId) await db.execute(sql`insert into edges (src, dst, type) values (${id}, ${def.projectId}, 'belongs_to') on conflict do nothing`);
    if (def.workflowId !== src.id || src.type === "workflow") await db.execute(sql`insert into edges (src, dst, type) values (${id}, ${def.workflowId}, 'scheduled_by') on conflict do nothing`).catch(() => undefined);
    await temporal.schedule.create({
      scheduleId: `chore-${id}`,
      spec: { cronExpressions: [body.cron], timezone: body.tz },
      // Each fire is a ChoreRunWorkflow that materialises a fresh task (ledger from the template) and runs it.
      action: { type: "startWorkflow", workflowType: "ChoreRunWorkflow", taskQueue: CLOUD_QUEUE, args: [{ choreId: id }], workflowId: `chore-${id}-run`, workflowExecutionTimeout: `${body.timeoutMinutes} minutes` },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
    return c.json({ id });
  });

  r.post("/chores/:id/pause", async (c) => { await temporal.schedule.getHandle(`chore-${c.req.param("id")}`).pause("paused from UI"); await db.execute(sql`update nodes set props = props || '{"paused":true}'::jsonb where id = ${c.req.param("id")}`); return c.json({ ok: true }); });
  r.post("/chores/:id/unpause", async (c) => { await temporal.schedule.getHandle(`chore-${c.req.param("id")}`).unpause(); await db.execute(sql`update nodes set props = props || '{"paused":false}'::jsonb where id = ${c.req.param("id")}`); return c.json({ ok: true }); });
  r.post("/chores/:id/trigger", async (c) => { await temporal.schedule.getHandle(`chore-${c.req.param("id")}`).trigger(ScheduleOverlapPolicy.ALLOW_ALL); return c.json({ ok: true }); });
  r.delete("/chores/:id", async (c) => { await temporal.schedule.getHandle(`chore-${c.req.param("id")}`).delete().catch(() => undefined); await db.execute(sql`delete from edges where src = ${c.req.param("id")}`); await db.execute(sql`delete from nodes where id = ${c.req.param("id")}`); return c.json({ ok: true }); });

  /** Morning brief: everything that happened in the window, per project. */
  r.get("/brief", async (c) => {
    const hours = Number(c.req.query("hours") ?? 12);
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const tasks = (await db.execute(sql`select id, title, props, created_at from nodes where type = 'task' and (created_at > ${since}::timestamptz or (props->>'updatedAt')::timestamptz > ${since}::timestamptz) order by created_at desc`)) as any[];
    const sessions = (await db.execute(sql`select id, title, props, created_at from nodes where type = 'session' and created_at > ${since}::timestamptz order by created_at desc`)) as any[];
    const grants = (await db.execute(sql`select g.action, g.cap, g.used, g.delegated, l.task_id, l.signed_by from grants g join ledgers l on l.id = g.ledger_id where l.signed_at > ${since}::timestamptz`)) as any[];
    const proposals = (await db.execute(sql`select id, title, props from nodes where type = 'proposal' and props->>'status' = 'proposed' order by created_at desc limit 20`)) as any[];
    const projects = (await db.execute(sql`select id, title, props from nodes where type = 'project' order by created_at`)) as any[];
    const spend = sessions.reduce((a, s) => a + Number(s.props.spendGbp ?? 0), 0);
    const cap = grants.filter((g) => g.action === "spend").reduce((a, g) => a + Number(g.cap?.gbp ?? 0), 0);
    const count = (st: string) => tasks.filter((t) => t.props.state === st).length;
    return c.json({
      window: { since, hours },
      totals: { completed: count("done"), parked: sessions.filter((s) => s.props.state === "parked").length, partial: count("stopped") + count("skipped"), awaiting: count("awaiting_go_ahead"), spendGbp: spend, capGbp: cap, grantsUsed: grants.filter((g) => Number(g.used?.count ?? 0) > 0).length, grantsTotal: grants.length, delegated: grants.filter((g) => g.delegated).length },
      projects: projects.map((p) => ({ ...p, tasks: tasks.filter((t) => t.props.projectId === p.id), sessions: sessions.filter((s) => s.props.projectId === p.id) })),
      unassigned: { tasks: tasks.filter((t) => !t.props.projectId), sessions: sessions.filter((s) => !s.props.projectId) },
      grants: grants.map((g) => ({ action: g.action, cap: g.cap, used: g.used, delegated: !!g.delegated, signedBy: g.signed_by })),
      proposals,
    });
  });
  return r;
}
