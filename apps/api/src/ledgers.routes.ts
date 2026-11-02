import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import type { Client } from "@temporalio/client";
import type { Grant, Ledger } from "@jj/core";
import { buildLedger, signLedger, grantForGap, type StepDef, type TemplateGrant } from "@jj/policy";
import { approve, notifyLedgerSigned, startOvernightBatch } from "@jj/workflows";
import { OUTWARD } from "./projects.routes.js";

const SECRET = process.env.LEDGER_SIGNING_SECRET ?? "dev-ledger-secret";

/** Next 08:00 local as the default expiry. */
export function nextExpiry(now = new Date()): string {
  const d = new Date(now); d.setHours(8, 0, 0, 0); if (d <= now) d.setDate(d.getDate() + 1); return d.toISOString();
}

export async function persistLedger(db: Db, l: Ledger, signedBy?: string) {
  await db.execute(sql`insert into ledgers (id, task_id, generated_at, signed_at, expires_at, signature, status, intended, never_pre_authorised, signed_by)
    values (${l.id}, ${l.taskId}, ${l.generatedAt}::timestamptz, ${l.signedAt ?? null}, ${l.expiresAt}::timestamptz, ${l.signature ?? null}, ${l.status}, ${JSON.stringify(l.grants.map((g) => ({ action: g.action, scope: g.scope, cap: g.cap })))}::jsonb, ${JSON.stringify(l.neverPreAuthorised)}::jsonb, ${signedBy ?? null})`);
  for (const g of l.grants) await db.execute(sql`insert into grants (id, ledger_id, action, scope, cap, used, delegated, expires_at) values (${g.id}, ${g.ledgerId}, ${g.action}, ${JSON.stringify(g.scope)}::jsonb, ${JSON.stringify(g.cap)}::jsonb, ${JSON.stringify(g.used)}::jsonb, ${g.delegated ? 1 : 0}, ${g.expiresAt}::timestamptz)`);
}

export async function loadLedger(db: Db, id: string): Promise<Ledger | undefined> {
  const [l] = (await db.execute(sql`select * from ledgers where id = ${id}`)) as any[];
  if (!l) return undefined;
  const gs = (await db.execute(sql`select * from grants where ledger_id = ${id}`)) as any[];
  return { id: l.id, taskId: l.task_id, generatedAt: new Date(l.generated_at).toISOString(), signedAt: l.signed_at ? new Date(l.signed_at).toISOString() : undefined, expiresAt: new Date(l.expires_at).toISOString(), signature: l.signature ?? undefined, status: l.status, neverPreAuthorised: l.never_pre_authorised ?? [],
    grants: gs.map((g) => ({ id: g.id, ledgerId: g.ledger_id, action: g.action, scope: g.scope, cap: g.cap ?? {}, used: g.used, expiresAt: new Date(g.expires_at ?? l.expires_at).toISOString(), delegated: !!g.delegated })) };
}

export async function signedGrantIdsForTask(db: Db, taskId: string): Promise<string[]> {
  const rows = (await db.execute(sql`select g.id from grants g join ledgers l on l.id = g.ledger_id where l.task_id = ${taskId} and l.status = 'signed' and l.expires_at > now()`)) as any[];
  return rows.map((r) => r.id);
}

/**
 * Mode => ledger. auto: template + steps signed immediately (the standing template is your standing consent).
 * assist: same grants minus outward/destructive actions, signed. manual: no ledger at all.
 * Anything not in the template and not declared by a step still parks on contact.
 */
export async function ledgerForTaskMode(db: Db, taskId: string, mode: string, steps: StepDef[], template: TemplateGrant[]): Promise<Ledger | undefined> {
  if (mode === "manual") return undefined;
  const l = buildLedger({ taskId, steps, template, expiresAt: nextExpiry() });
  if (mode === "assist") l.grants = l.grants.filter((g) => !OUTWARD.test(g.action));
  l.status = "signed"; l.signedAt = new Date().toISOString(); l.signature = signLedger(l, SECRET);
  await persistLedger(db, l, `mode:${mode}`);
  return l;
}

export function ledgerRoutes(db: Db, temporal: Client) {
  const r = new Hono();

  /** Draft ledger for a queued task (overnight). */
  r.post("/ledgers/generate", async (c) => {
    const { taskId } = z.object({ taskId: z.string().uuid() }).parse(await c.req.json());
    const [t] = (await db.execute(sql`select props from nodes where id = ${taskId} and type = 'task'`)) as any[];
    if (!t) return c.json({ error: "task not found" }, 404);
    const [wf] = (await db.execute(sql`select props from nodes where id = ${t.props.workflowId}`)) as any[];
    const [pj] = t.props.projectId ? (await db.execute(sql`select props from nodes where id = ${t.props.projectId}`)) as any[] : [undefined];
    await db.execute(sql`update ledgers set status = 'revoked' where task_id = ${taskId} and status = 'draft'`);
    const l = buildLedger({ taskId, steps: t.props.steps ?? [], template: pj?.props?.grantTemplate ?? wf?.props?.grantTemplate ?? [], expiresAt: nextExpiry() });
    await persistLedger(db, l);
    return c.json({ ledger: l });
  });

  r.get("/ledgers", async (c) => {
    const status = c.req.query("status");
    const rows = (await db.execute(status
      ? sql`select l.id, l.task_id, l.status, l.expires_at, l.signed_at, l.never_pre_authorised, t.title, t.props as task from ledgers l join nodes t on t.id = l.task_id where l.status = ${status} order by l.generated_at desc limit 50`
      : sql`select l.id, l.task_id, l.status, l.expires_at, l.signed_at, l.never_pre_authorised, t.title, t.props as task from ledgers l join nodes t on t.id = l.task_id order by l.generated_at desc limit 50`)) as any[];
    const out = [];
    for (const row of rows) out.push({ ...row, grants: (await db.execute(sql`select id, action, scope, cap, used, delegated from grants where ledger_id = ${row.id}`)) });
    return c.json({ ledgers: out });
  });
  r.get("/ledgers/:id", async (c) => { const l = await loadLedger(db, c.req.param("id")); return l ? c.json({ ledger: l }) : c.json({ error: "not found" }, 404); });

  /** Sign: optionally edit caps/scopes or drop grants first. Signature covers the final set. */
  r.post("/ledgers/:id/sign", async (c) => {
    const body = z.object({ grants: z.array(z.object({ id: z.string().uuid(), cap: z.object({ count: z.number().int().positive().optional(), gbp: z.number().positive().optional() }).optional(), scope: z.record(z.union([z.string(), z.array(z.string())])).optional(), remove: z.boolean().optional() })).default([]), expiresAt: z.string().datetime().optional(), signedBy: z.string().default("you:ui") }).parse(await c.req.json().catch(() => ({})));
    const l = await loadLedger(db, c.req.param("id"));
    if (!l) return c.json({ error: "not found" }, 404);
    if (l.status !== "draft") return c.json({ error: `ledger is ${l.status}` }, 409);
    for (const e of body.grants) {
      if (e.remove) { l.grants = l.grants.filter((g) => g.id !== e.id); await db.execute(sql`delete from grants where id = ${e.id}`); continue; }
      const g = l.grants.find((g) => g.id === e.id); if (!g) continue;
      if (e.cap) g.cap = e.cap; if (e.scope) g.scope = e.scope;
      await db.execute(sql`update grants set cap = ${JSON.stringify(g.cap)}::jsonb, scope = ${JSON.stringify(g.scope)}::jsonb where id = ${g.id}`);
    }
    if (body.expiresAt) { l.expiresAt = body.expiresAt; for (const g of l.grants) g.expiresAt = body.expiresAt; }
    l.status = "signed"; l.signedAt = new Date().toISOString(); l.signature = signLedger(l, SECRET);
    await db.execute(sql`update ledgers set status = 'signed', signed_at = now(), signature = ${l.signature}, expires_at = ${l.expiresAt}::timestamptz, signed_by = ${body.signedBy} where id = ${l.id}`);
    await db.execute(sql`update grants set expires_at = ${l.expiresAt}::timestamptz where ledger_id = ${l.id}`);
    await notifyLedgerSigned(temporal, l.taskId, l.grants.map((g) => g.id));
    return c.json({ ledger: l });
  });
  r.post("/ledgers/:id/skip", async (c) => {
    const l = await loadLedger(db, c.req.param("id")); if (!l) return c.json({ error: "not found" }, 404);
    await db.execute(sql`update ledgers set status = 'revoked' where id = ${l.id}`);
    await db.execute(sql`update nodes set props = props || '{"state":"skipped","reason":"skipped by you"}'::jsonb where id = ${l.taskId}`);
    return c.json({ ok: true });
  });

  r.post("/approvals/:callId", async (c) => {
    const body = z.object({ sessionId: z.string().uuid(), mode: z.enum(["once", "widen", "deny"]), by: z.string().default("you:ui") }).parse(await c.req.json());
    return c.json(await decide(db, temporal, { ...body, callId: c.req.param("callId") }));
  });

  /** Slack interactivity endpoint: verify, decide, update the card. */
  r.post("/slack/interactions", async (c) => {
    const raw = await c.req.text();
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (secret) {
      const ts = c.req.header("x-slack-request-timestamp") ?? "0"; const sig = c.req.header("x-slack-signature") ?? "";
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return c.text("stale", 401);
      const { createHmac, timingSafeEqual } = await import("node:crypto");
      const mine = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex");
      if (mine.length !== sig.length || !timingSafeEqual(Buffer.from(mine), Buffer.from(sig))) return c.text("bad signature", 401);
    }
    const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}");
    const action = payload.actions?.[0]; if (!action) return c.json({ ok: true });
    const { sessionId, callId } = JSON.parse(action.value);
    const mode = action.action_id === "approve_once" ? "once" : action.action_id === "approve_widen" ? "widen" : "deny";
    const by = `you:slack:${payload.user?.username ?? payload.user?.id ?? "?"}`;
    await decide(db, temporal, { sessionId, callId, mode, by });
    if (payload.response_url) await fetch(payload.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text: `${mode === "deny" ? "Denied" : mode === "widen" ? "Approved and added to grant" : "Approved once"} by ${payload.user?.username ?? "you"} at ${new Date().toISOString().slice(11, 16)}` }) }).catch(() => undefined);
    return c.text("");
  });

  /** Kick the overnight batch now (the Schedule does this at 22:00). */
  r.post("/overnight/run", async (c) => {
    const body = z.object({ until: z.string().datetime().optional(), signDeadlineMinutes: z.number().int().positive().optional(), concurrency: z.number().int().positive().optional() }).parse(await c.req.json().catch(() => ({})));
    const until = body.until ?? new Date(Date.now() + 12 * 3600_000).toISOString();
    const h = await startOvernightBatch(temporal, until, body);
    return c.json({ workflowId: h.workflowId });
  });
  return r;
}

/** Approve/deny/widen a parked call. Widen mints a delegated grant for exactly the gap and pushes it to the live session. */
export async function decide(db: Db, temporal: Client, body: { sessionId: string; callId: string; mode: "once" | "widen" | "deny"; by: string }) {
  let grantIds: string[] | undefined;
  if (body.mode === "widen") {
    const [s] = (await db.execute(sql`select props from nodes where id = ${body.sessionId}`)) as any[];
    const tool = s?.props?.parkedTool; const args = s?.props?.parkedArgs ?? {};
    if (!tool) throw new Error("no parked call details on this session");
    let ledgerId: string | undefined = ((await db.execute(sql`select l.id from ledgers l where l.task_id = ${s.props.taskId} and l.status = 'signed' order by l.signed_at desc limit 1`)) as any[])[0]?.id;
    if (!ledgerId) { const l = buildLedger({ taskId: s.props.taskId, steps: [], expiresAt: nextExpiry() }); l.status = "signed"; l.signedAt = new Date().toISOString(); l.signature = signLedger(l, SECRET); await persistLedger(db, l, "delegated"); ledgerId = l.id; }
    const g = grantForGap(ledgerId, tool, args, nextExpiry());
    await db.execute(sql`insert into grants (id, ledger_id, action, scope, cap, used, delegated, expires_at) values (${g.id}, ${g.ledgerId}, ${g.action}, ${JSON.stringify(g.scope)}::jsonb, ${JSON.stringify(g.cap)}::jsonb, ${JSON.stringify(g.used)}::jsonb, 1, ${g.expiresAt}::timestamptz)`);
    grantIds = [g.id];
  }
  await approve(temporal, body.sessionId, body.callId, body.mode, grantIds);
  await db.execute(sql`update nodes set props = props || ${JSON.stringify({ state: "running", parkedCallId: null, parkedGap: null, lastDecision: body.mode })}::jsonb where id = ${body.sessionId}`);
  await db.execute(sql`insert into audit_log (session_id, tool, args_hash, decision, grant_id, decided_by, payload) values (${body.sessionId}, 'approval', ${body.callId}, ${body.mode === "deny" ? "deny" : "allow"}, ${grantIds?.[0] ?? null}, ${body.by}, ${JSON.stringify({ mode: body.mode })}::jsonb)`);
  return { ok: true, grantIds };
}
