import { Hono } from "hono";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "@jj/graph";
import { neighbourhood, similarSessions } from "@jj/graph";
import { applySkillLessons } from "./skills.js";

export const WorkflowDef = z.object({
  id: z.string().uuid().optional(),
  title: z.string(),
  description: z.string().optional(),
  steps: z.array(z.object({
    name: z.string(), prompt: z.string(),
    skills: z.array(z.string()).default([]), connectors: z.array(z.string()).default([]),
    preferredVendor: z.enum(["claude", "openai", "gemini"]).optional(), reviewerOfPrevious: z.boolean().optional(),
    maxCostGbp: z.number().positive().default(2),
    after: z.array(z.string()).optional(), retry: z.number().int().min(0).max(5).optional(), onFailure: z.string().optional(),
    interactive: z.boolean().optional(), idleMinutes: z.number().int().positive().optional(), requires: z.array(z.string()).optional(),
    /** What the planner will put in the ledger for this step. */
    intendedActions: z.array(z.object({ tool: z.string(), scope: z.record(z.union([z.string(), z.array(z.string())])).default({}), cap: z.object({ count: z.number().int().positive().optional(), gbp: z.number().positive().optional() }).default({}) })).default([]),
  })).min(1),
  /** Standing grants every run of this workflow gets without asking (chores auto-sign these). */
  grantTemplate: z.array(z.object({ action: z.string(), scope: z.record(z.union([z.string(), z.array(z.string())])).default({}), cap: z.object({ count: z.number().int().positive().optional(), gbp: z.number().positive().optional() }).default({}) })).default([]),
  runnerId: z.string().default("laptop"),
});
export type WorkflowDef = z.infer<typeof WorkflowDef>;

export function graphRoutes(db: Db) {
  const r = new Hono();

  r.get("/graph/:id", async (c) => {
    const id = c.req.param("id");
    const [node] = (await db.execute(sql`select id, type, title, props, created_at, updated_at from nodes where id = ${id}`)) as any[];
    if (!node) return c.json({ error: "not found" }, 404);
    const neigh = (await neighbourhood(db, id)) as any[];
    const grouped: Record<string, any[]> = {};
    for (const n of neigh) (grouped[n.edge] ??= []).push(n);
    const similar = node.type === "session" ? await similarSessions(db, id) : [];
    const tail = node.type === "session" ? (await db.execute(sql`select payload from session_events where session_id = ${id} order by seq desc limit 12`)) as any[] : [];
    return c.json({ node, neighbours: grouped, similar, transcriptTail: tail.map((t) => t.payload).reverse() });
  });

  r.get("/workflows", async (c) => {
    const rows = await db.execute(sql`
      select w.id, w.title, w.props, w.created_at,
        (select count(*) from edges e join nodes s on s.id = e.src where e.dst = w.id and e.type = 'part_of' and s.type = 'session')::int as runs,
        (select count(*) from nodes p where p.type = 'proposal' and p.props->>'workflowId' = w.id::text and p.props->>'status' = 'proposed')::int as proposals,
        (select count(*) from nodes ch where ch.type = 'chore' and ch.props->>'workflowId' = w.id::text)::int as chores
      from nodes w where w.type = 'workflow' order by w.created_at desc`);
    return c.json({ workflows: rows });
  });

  r.post("/workflows", async (c) => {
    const def = WorkflowDef.parse(await c.req.json());
    const id = def.id ?? crypto.randomUUID();
    const props = { ...def, id: undefined, title: undefined };
    await db.execute(sql`insert into nodes (id, type, title, props) values (${id}, 'workflow', ${def.title}, ${JSON.stringify(props)}::jsonb)
      on conflict (id) do update set title = excluded.title, props = nodes.props || excluded.props, updated_at = now()`);
    for (const s of def.steps) for (const sk of s.skills) {
      const [skill] = (await db.execute(sql`select id from nodes where type = 'skill' and title = ${sk}`)) as any[];
      const sid = skill?.id ?? crypto.randomUUID();
      if (!skill) await db.execute(sql`insert into nodes (id, type, title, props) values (${sid}, 'skill', ${sk}, '{"version":1}'::jsonb)`);
      await db.execute(sql`insert into edges (src, dst, type) values (${id}, ${sid}, 'uses_skill') on conflict do nothing`);
    }
    return c.json({ id });
  });

  r.get("/workflows/:id", async (c) => {
    const id = c.req.param("id");
    const [wf] = (await db.execute(sql`select id, title, props, created_at from nodes where id = ${id} and type = 'workflow'`)) as any[];
    if (!wf) return c.json({ error: "not found" }, 404);
    const runs = await db.execute(sql`
      select s.id, s.title, s.props, s.created_at from edges e join nodes s on s.id = e.src
      where e.dst = ${id} and e.type = 'part_of' and s.type = 'session' order by s.created_at desc limit 20`);
    const proposals = await db.execute(sql`select id, title, props, created_at from nodes where type = 'proposal' and props->>'workflowId' = ${id} and props->>'status' = 'proposed' order by created_at desc`);
    const chores = await db.execute(sql`select id, title, props from nodes where type = 'chore' and props->>'workflowId' = ${id}`);
    const skills = await db.execute(sql`select n.id, n.title, n.props from edges e join nodes n on n.id = e.dst where e.src = ${id} and e.type = 'uses_skill'`);
    return c.json({ workflow: wf, runs, proposals, chores, skills });
  });

  r.get("/proposals", async (c) => {
    const status = c.req.query("status") ?? "proposed";
    const rows = await db.execute(sql`select id, title, props, created_at from nodes where type = 'proposal' and props->>'status' = ${status} order by created_at desc limit 100`);
    return c.json({ proposals: rows });
  });

  r.post("/proposals/:id/:decision", async (c) => {
    const id = c.req.param("id"); const decision = c.req.param("decision");
    if (!["accept", "reject"].includes(decision)) return c.json({ error: "accept|reject" }, 400);
    const [p] = (await db.execute(sql`select props from nodes where id = ${id} and type = 'proposal'`)) as any[];
    if (!p) return c.json({ error: "not found" }, 404);
    const props = p.props;
    if (decision === "accept") {
      const [wf] = (await db.execute(sql`select props from nodes where id = ${props.workflowId}`)) as any[];
      let template: any[] = wf?.props?.grantTemplate ?? [];
      if (props.kind === "add_grant" && !template.some((g) => g.action === props.tool)) template = [...template, { action: props.tool, scope: {}, cap: { count: 20 } }];
      if (props.kind === "remove_grant") template = template.filter((g) => g.action !== props.tool);
      await db.execute(sql`update nodes set props = props || ${JSON.stringify({ grantTemplate: template, templateVersion: (wf?.props?.templateVersion ?? 1) + 1 })}::jsonb, updated_at = now() where id = ${props.workflowId}`);
      if (props.kind === "skill_edit") {
        const [skill] = (await db.execute(sql`select n.id, n.title, n.props from edges e join nodes n on n.id = e.dst where e.src = ${props.workflowId} and e.type = 'uses_skill' limit 1`)) as any[];
        if (skill) {
          const version = (skill.props.version ?? 1) + 1;
          const written = await applySkillLessons(skill.title, props.lessons ?? [], version).catch((e) => ({ path: String(e), committed: false }));
          const newId = crypto.randomUUID();
          await db.execute(sql`insert into nodes (id, type, title, props) values (${newId}, 'skill', ${skill.title}, ${JSON.stringify({ version, written })}::jsonb)`);
          await db.execute(sql`insert into edges (src, dst, type) values (${skill.id}, ${newId}, 'superseded_by') on conflict do nothing`);
          await db.execute(sql`update edges set dst = ${newId} where dst = ${skill.id} and type = 'uses_skill'`);
          await db.execute(sql`update nodes set props = props || ${JSON.stringify({ written })}::jsonb where id = ${id}`);
        }
      }
    }
    await db.execute(sql`update nodes set props = props || ${JSON.stringify({ status: decision === "accept" ? "accepted" : "rejected", decidedAt: new Date().toISOString() })}::jsonb where id = ${id}`);
    return c.json({ ok: true });
  });

  return r;
}
