import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { SessionEvent, Grant } from "@jj/core";
import { createDb, appendEvents, recordDecision, upsertSessionNode, neighbourhood, similarSessions } from "@jj/graph";
import { temporalClient, startTask, approve, cancel, status, nudge, pauseTask, type TaskDefinition } from "@jj/workflows";
import { EventBus } from "./bus.js";
import { graphRoutes } from "./graph.routes.js";
import { projectRoutes } from "./projects.routes.js";
import { ledgerRoutes, ledgerForTaskMode, signedGrantIdsForTask } from "./ledgers.routes.js";
import { choreRoutes, ensureSystemSchedules } from "./chores.routes.js";
import { ingestRoutes } from "./ingest.routes.js";
import { resolveRunnerId } from "./runner-selection.js";

const { db } = createDb();
const bus = new EventBus();
const temporal = await temporalClient();
const tokens = new Set((process.env.API_INGEST_TOKENS ?? "dev-token").split(","));

const app = new Hono();
app.use("*", cors());
app.onError((err, c) => { console.error(`[api] ${c.req.method} ${c.req.path}:`, err); return c.json({ error: String(err) }, 500); });

const auth = (c: any, next: any) => {
  const t = (c.req.header("authorization") ?? "").replace("Bearer ", "");
  if (!tokens.has(t)) return c.text("unauthorised", 401);
  return next();
};

// --- ingest from runner daemons ---------------------------------------------
app.post("/events", auth, async (c) => {
  const body = z.object({ events: z.array(SessionEvent) }).parse(await c.req.json());
  await appendEvents(db, body.events);
  for (const e of body.events) {
    bus.publish(e);
    if (e.type === "started") await upsertSessionNode(db, e.sessionId, "", { state: "running", vendor: e.vendor, runnerId: e.runnerId, startedAt: e.ts });
    if (e.type === "cost") await upsertSessionNode(db, e.sessionId, "", { spendGbp: e.cumulativeGbp, tokensIn: e.tokensIn, tokensOut: e.tokensOut });
    if (e.type === "approval_request") await upsertSessionNode(db, e.sessionId, "", { state: "parked", parkedCallId: e.callId, parkedGap: e.grantGap, parkedTool: e.tool, parkedArgs: e.args, parkedAt: e.ts });
    if (e.type === "done") { await upsertSessionNode(db, e.sessionId, "", { state: "done", outcome: e.outcome, endedAt: e.ts }); }
    if (e.type === "message" || e.type === "tool_call" || e.type === "tool_result") await upsertSessionNode(db, e.sessionId, "", { lastEvent: summary(e), lastEventAt: e.ts });
  }
  return c.json({ ok: true, count: body.events.length });
});

app.post("/audit", auth, async (c) => {
  const row = z.object({ sessionId: z.string().uuid(), tool: z.string(), argsHash: z.string(), decision: z.string(), grantId: z.string().uuid().optional(), decidedBy: z.string() }).parse(await c.req.json());
  await recordDecision(db, row);
  if (row.decision === "allow" && row.grantId) await db.execute(sql`update grants set used = jsonb_set(used, '{count}', (coalesce((used->>'count')::int,0) + 1)::text::jsonb) where id = ${row.grantId}`);
  return c.json({ ok: true });
});

app.get("/grants", auth, async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
  if (!ids.length) return c.json({ grants: [] });
  const rows = await db.execute(sql`select g.*, l.expires_at from grants g join ledgers l on l.id = g.ledger_id where g.id = any(${`{${ids.join(",")}}`}::uuid[]) and l.status = 'signed'`);
  const grants = rows.map((r: any) => Grant.parse({ id: r.id, ledgerId: r.ledger_id, action: r.action, scope: r.scope, cap: r.cap ?? {}, used: r.used, expiresAt: new Date(r.expires_at).toISOString(), delegated: !!r.delegated }));
  return c.json({ grants });
});

// --- internal hooks from cloud activities ------------------------------------
app.post("/internal/parked", async (c) => {
  const b = await c.req.json();
  await upsertSessionNode(db, b.sessionId, "", { state: "parked", parkedCallId: b.callId, parkedGap: b.gap, parkedAt: new Date().toISOString() });
  return c.json({ ok: true });
});
app.post("/internal/index", async (c) => {
  const b = await c.req.json();
  await temporal.workflow.start("IndexWorkflow", { args: [{ sessionId: b.sessionId }], taskQueue: "cloud", workflowId: `index-${b.sessionId}-${Date.now()}` });
  return c.json({ ok: true });
});

// --- reads for the pane of glass ---------------------------------------------
app.get("/sessions", async (c) => {
  const rows = await db.execute(sql`select id, title, props, created_at, updated_at from nodes where type = 'session' order by created_at desc limit 100`);
  return c.json({ sessions: rows });
});
app.get("/sessions/:id/events", async (c) => {
  const rows = await db.execute(sql`select payload from session_events where session_id = ${c.req.param("id")} order by seq asc`);
  return c.json({ events: rows.map((r: any) => r.payload) });
});
app.get("/sessions/:id/status", async (c) => {
  try { return c.json(await status(temporal, c.req.param("id"))); } catch { return c.json({ state: "unknown" }, 404); }
});
app.get("/sessions/:id/neighbours", async (c) => c.json({ neighbours: await neighbourhood(db, c.req.param("id")), similar: await similarSessions(db, c.req.param("id")) }));
app.get("/parked", async (c) => {
  const rows = await db.execute(sql`select id, title, props from nodes where type = 'session' and props->>'state' = 'parked' order by (props->>'parkedAt') asc nulls last`);
  return c.json({ parked: (rows as any[]).map((r) => ({ sessionId: r.id, title: r.title, callId: r.props.parkedCallId, gap: r.props.parkedGap, at: r.props.parkedAt, tool: String(r.props.parkedGap ?? "").replace(/^no grant for /, "") })) });
});

app.get("/events", (c) => {
  const since = Number(c.req.query("since") ?? 0);
  return streamSSE(c, async (stream) => {
    for (const b of bus.since(since)) await stream.writeSSE({ id: String(b.cursor), event: b.event.type, data: JSON.stringify(b.event) });
    const unsub = bus.subscribe((cursor, e) => { void stream.writeSSE({ id: String(cursor), event: e.type, data: JSON.stringify(e) }); });
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15000);
    await new Promise<void>((resolve) => { stream.onAbort(() => { unsub(); clearInterval(ping); resolve(); }); });
  });
});

// --- commands ------------------------------------------------------------------
const StartTask = z.object({
  title: z.string().optional(), workflowId: z.string().uuid(), runnerId: z.string().optional(), grantIds: z.array(z.string().uuid()).default([]),
  steps: z.array(z.object({ name: z.string(), prompt: z.string(), skills: z.array(z.string()).optional(), connectors: z.array(z.string()).optional(), requires: z.array(z.string()).optional(), preferredVendor: z.enum(["claude", "openai", "gemini"]).optional(), reviewerOfPrevious: z.boolean().optional(), maxCostGbp: z.number().positive(), after: z.array(z.string()).optional(), retry: z.number().int().min(0).max(5).optional(), onFailure: z.string().optional(), interactive: z.boolean().optional(), idleMinutes: z.number().int().positive().optional() })).min(1).optional(),
  scheduledFor: z.string().datetime().optional(),   // set => queued for the overnight batch instead of starting now
  priority: z.number().int().optional(), runnerAffinity: z.enum(["fixed", "any"]).optional(), budgetGbp: z.number().positive().optional(), deadline: z.string().datetime().optional(),
});
app.post("/tasks", async (c) => {
  const body = StartTask.parse(await c.req.json());
  const [wf] = (await db.execute(sql`select title, props from nodes where id = ${body.workflowId} and type = 'workflow'`)) as any[];
  const steps = body.steps ?? wf?.props?.steps;
  if (!steps?.length) return c.json({ error: "no steps: pass steps or a workflowId with a definition" }, 400);
  const title = body.title ?? wf?.title ?? "Task";
  const def: TaskDefinition = { taskId: crypto.randomUUID(), title, workflowId: body.workflowId, runnerId: resolveRunnerId(body.runnerId, wf?.props?.runnerId, process.env.DEFAULT_RUNNER_ID), grantIds: body.grantIds, steps, priority: body.priority, runnerAffinity: body.runnerAffinity, budgetGbp: body.budgetGbp, deadline: body.deadline };
  if (body.scheduledFor) {
    await db.execute(sql`insert into nodes (id, type, title, props) values (${def.taskId}, 'task', ${title}, ${JSON.stringify({ steps, runnerId: def.runnerId, workflowId: body.workflowId, scheduledFor: body.scheduledFor, state: "queued", priority: body.priority, runnerAffinity: body.runnerAffinity, budgetGbp: body.budgetGbp, deadline: body.deadline })}::jsonb)`);
    return c.json({ taskId: def.taskId, queued: true });
  }
  await db.execute(sql`insert into nodes (id, type, title, props) values (${def.taskId}, 'task', ${def.title}, ${JSON.stringify({ steps: def.steps.length, runnerId: def.runnerId, workflowId: def.workflowId, state: "started" })}::jsonb) on conflict do nothing`);
  await db.execute(sql`insert into nodes (id, type, title, props) values (${def.workflowId}, 'workflow', ${def.title}, '{}'::jsonb) on conflict do nothing`);
  const h = await startTask(temporal, def);
  return c.json({ taskId: def.taskId, workflowRunId: h.firstExecutionRunId });
});
app.post("/sessions/:id/cancel", async (c) => { await cancel(temporal, c.req.param("id"), "cancelled from UI"); return c.json({ ok: true }); });
// B1: follow-up into an interactive session
app.post("/sessions/:id/send", async (c) => {
  const body = z.object({ text: z.string().min(1), final: z.boolean().optional() }).parse(await c.req.json());
  await nudge(temporal, c.req.param("id"), body.text, body.final);
  return c.json({ ok: true });
});
// daemon-side notes on a session (workdir, branch, worktree outcome)
app.post("/sessions/:id/note", auth, async (c) => { await upsertSessionNode(db, c.req.param("id"), "", await c.req.json()); return c.json({ ok: true }); });
// B3: runner registry
app.post("/runners/heartbeat", auth, async (c) => {
  const info = await c.req.json();
  const [r] = (await db.execute(sql`select id from nodes where type = 'runner' and title = ${info.runnerId}`)) as any[];
  const id = r?.id ?? crypto.randomUUID();
  await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'runner', ${info.runnerId}, ${JSON.stringify({ ...info, lastSeen: new Date().toISOString() })}::jsonb)
    on conflict (id) do update set props = nodes.props || excluded.props, updated_at = now()`);
  return c.json({ ok: true });
});
app.get("/runners", async (c) => {
  const rows = (await db.execute(sql`select id, title, props from nodes where type = 'runner' order by title`)) as any[];
  return c.json({ runners: rows.map((r) => ({ ...r, live: Date.now() - Date.parse(r.props.lastSeen ?? 0) < 120_000 })) });
});
// C5: pause/resume a task between waves
app.post("/tasks/:id/pause", async (c) => { await pauseTask(temporal, c.req.param("id"), true); return c.json({ ok: true }); });
app.post("/tasks/:id/resume", async (c) => { await pauseTask(temporal, c.req.param("id"), false); return c.json({ ok: true }); });

app.route("/", graphRoutes(db));
app.route("/", projectRoutes(db, temporal));
app.route("/", ledgerRoutes(db, temporal));
app.route("/", choreRoutes(db, temporal));
app.route("/", ingestRoutes(db, temporal));

app.post("/internal/materialise", async (c) => {
  const { choreId, taskId } = await c.req.json();
  const [ch] = (await db.execute(sql`select title, props from nodes where id = ${choreId}`)) as any[];
  if (!ch) return c.json({ error: "chore not found" }, 404);
  const def = ch.props.def; const mode = ch.props.mode ?? "auto";
  const [pj] = def.projectId ? (await db.execute(sql`select props from nodes where id = ${def.projectId}`)) as any[] : [undefined];
  const [wf] = (await db.execute(sql`select props from nodes where id = ${def.workflowId}`)) as any[];
  // refresh the snapshot from the live project/workflow so edits apply to the next fire
  const steps = (pj?.props?.continueSteps ?? wf?.props?.steps ?? def.steps);
  const title = `${ch.title} ${new Date().toISOString().slice(0, 16)}`;
  await db.execute(sql`insert into nodes (id, type, title, props) values (${taskId}, 'task', ${title}, ${JSON.stringify({ steps, runnerId: def.runnerId, workflowId: def.workflowId, projectId: def.projectId, mode, projectWorkdir: pj?.props?.workdir ?? def.projectWorkdir, choreId, state: "starting" })}::jsonb)`);
  await db.execute(sql`insert into edges (src, dst, type) values (${taskId}, ${choreId}, 'scheduled_by') on conflict do nothing`);
  const ledger = await ledgerForTaskMode(db, taskId, mode, steps, pj?.props?.grantTemplate ?? wf?.props?.grantTemplate ?? []);
  return c.json({ def: { steps, title, mode, projectWorkdir: pj?.props?.workdir ?? def.projectWorkdir }, grantIds: ledger?.status === "signed" ? await signedGrantIdsForTask(db, taskId) : [] });
});

app.get("/audit", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 200), 1000);
  const rows = await db.execute(sql`select a.id, a.ts, a.session_id, a.tool, a.args_hash, a.decision, a.grant_id, a.decided_by, a.payload, s.title as session_title, s.props->>'projectId' as project_id
    from audit_log a left join nodes s on s.id = a.session_id order by a.id desc limit ${limit}`);
  return c.json({ audit: rows });
});
app.get("/timeline", async (c) => {
  const hours = Number(c.req.query("hours") ?? 18);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const rows = await db.execute(sql`select id, title, props, created_at from nodes where type = 'session' and (created_at > ${since}::timestamptz or props->>'state' in ('running','parked','starting')) order by created_at`);
  const queued = await db.execute(sql`select id, title, props from nodes where type = 'task' and props->>'state' = 'queued' order by props->>'scheduledFor'`);
  return c.json({ sessions: rows, queued });
});

app.get("/healthz", (c) => c.json({ ok: true }));

function summary(e: SessionEvent): string {
  if (e.type === "tool_call") return `tool_call  ${e.tool}  ${e.policyDecision}`;
  if (e.type === "tool_result") return `tool_result  ${e.summary.slice(0, 60)}`;
  if (e.type === "message") return `message  ${e.text.slice(0, 60)}`;
  return e.type;
}

await ensureSystemSchedules(temporal).catch((e) => console.error("[api] schedules", e));
const port = Number(process.env.API_PORT ?? 4000);
serve({ fetch: app.fetch, port });
console.log(`[api] listening on :${port}`);
