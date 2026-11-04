import { createDb, upsertSessionNode, addEdge } from "@jj/graph";
import { sql } from "drizzle-orm";
import type { CloudActivities } from "./activities.js";
import { Connection, Client } from "@temporalio/client";
import { CLOUD_QUEUE } from "./shared.js";

export function createCloudActivities(): CloudActivities {
  const { db } = createDb();
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  const acts: CloudActivities = {
    async createSessionNode({ sessionId, title, props }) {
      await upsertSessionNode(db, sessionId, title, props);
    },
    async linkSessionToWorkflow({ sessionId, workflowId, taskId }) {
      await addEdge(db, sessionId, workflowId, "part_of").catch(() => undefined);
      await addEdge(db, sessionId, taskId, "part_of").catch(() => undefined);
    },
    async recordOutcome({ sessionId, outcome, spendGbp }) {
      await upsertSessionNode(db, sessionId, "", { state: outcome, spendGbp });
    },
    async postSlackCard({ sessionId, callId, gap }) {
      await fetch(`${apiUrl}/internal/parked`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, callId, gap }) }).catch(() => undefined);
      const token = process.env.SLACK_BOT_TOKEN, channel = process.env.SLACK_APPROVALS_CHANNEL;
      if (!token || !channel) return;
      const [s] = (await db.execute(sql`select title, props from nodes where id = ${sessionId}`)) as any[];
      const p = s?.props ?? {};
      const value = JSON.stringify({ sessionId, callId });
      const blocks = [
        { type: "header", text: { type: "plain_text", text: "Approval needed" } },
        { type: "section", text: { type: "mrkdwn", text: `*${p.parkedTool ?? "tool"}*\n${s?.title ?? sessionId}\n_${gap}_` } },
        { type: "section", fields: [
          { type: "mrkdwn", text: `*Vendor*\n${p.vendor ?? "?"}` }, { type: "mrkdwn", text: `*Mode*\n${p.mode ?? "?"}` },
          { type: "mrkdwn", text: `*Spend*\n£${(p.spendGbp ?? 0).toFixed(2)}` }, { type: "mrkdwn", text: `*Runner*\n${p.runnerId ?? "?"}` } ] },
        ...(p.parkedArgs ? [{ type: "context", elements: [{ type: "mrkdwn", text: "```" + JSON.stringify(p.parkedArgs).slice(0, 600) + "```" }] }] : []),
        { type: "actions", elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve once" }, action_id: "approve_once", value },
          { type: "button", text: { type: "plain_text", text: "Add to grant" }, action_id: "approve_widen", value },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Deny" }, action_id: "approve_deny", value } ] },
      ];
      const r = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ channel, text: `Approval needed: ${p.parkedTool ?? "tool"} (${gap})`, blocks }) });
      const j: any = await r.json().catch(() => ({}));
      if (j.ok) await db.execute(sql`update nodes set props = props || ${JSON.stringify({ slackTs: j.ts, slackChannel: channel })}::jsonb where id = ${sessionId}`);
    },
    async markTask({ taskId, state, extra }) {
      await db.execute(sql`update nodes set props = props || ${JSON.stringify({ state, ...(extra ?? {}), updatedAt: new Date().toISOString() })}::jsonb, updated_at = now() where id = ${taskId}`);
    },
    async projectContext({ projectId }) {
      const [proj] = (await db.execute(sql`select title, props from nodes where id = ${projectId}`)) as any[];
      if (!proj) return "";
      const recent = (await db.execute(sql`
        select s.title, s.props, s.created_at from nodes s where s.type = 'session' and s.props->>'projectId' = ${projectId}
          and s.props->>'outcome' is not null order by s.created_at desc limit 3`)) as any[];
      const parked = (await db.execute(sql`select title, props from nodes where type = 'session' and props->>'projectId' = ${projectId} and props->>'state' = 'parked'`)) as any[];
      const accepted = (await db.execute(sql`select props from nodes where type = 'proposal' and props->>'status' = 'accepted' and props->>'projectId' = ${projectId} order by created_at desc limit 5`)) as any[];
      const lines: string[] = [`# Project: ${proj.title}`];
      if (proj.props.goal) lines.push(`Goal: ${proj.props.goal}`);
      if (recent.length) {
        lines.push("", "## Recent sessions (newest first)");
        for (const r of recent) {
          const sm = r.props.summary ?? {};
          lines.push(`- ${new Date(r.created_at).toISOString().slice(0, 16)} ${r.title}: ${r.props.outcome}, ${(sm.tools ? Object.keys(sm.tools).join(", ") : "no tools")}, £${(r.props.spendGbp ?? 0).toFixed(2)}`);
          for (const l of (r.props.lessons ?? []).slice(0, 3)) lines.push(`  - lesson: ${l}`);
          if (sm.artifacts?.length) lines.push(`  - artifacts: ${sm.artifacts.map((a: any) => a.title || a.uri).join(", ")}`);
        }
      }
      if (parked.length) lines.push("", "## Still waiting on approval", ...parked.map((p) => `- ${p.title}: ${p.props.parkedGap}`));
      const mem = proj.props.memory;
      if (mem && (mem.decisions?.length || mem.conventions?.length || mem.openQuestions?.length)) {
        lines.push("", "## Project memory");
        for (const d of mem.decisions ?? []) lines.push(`- decision: ${d}`);
        for (const c of mem.conventions ?? []) lines.push(`- convention: ${c}`);
        for (const q of mem.openQuestions ?? []) lines.push(`- open question: ${q}`);
      }
      if (accepted.length) lines.push("", "## Accepted changes", ...accepted.flatMap((a) => (a.props.lessons ?? [a.props.title]).map((l: string) => `- ${l}`)));
      lines.push("", "Continue from where the last session left off. Do not redo completed work.");
      return lines.join("\n");
    },
    async tonightTasks({ until }) {
      const rows = (await db.execute(sql`
        select t.id, t.title, t.props, l.id as ledger_id, l.status as ledger_status,
          (select coalesce(json_agg(g.id), '[]'::json) from grants g where g.ledger_id = l.id) as grant_ids
        from nodes t left join ledgers l on l.task_id = t.id
        where t.type = 'task' and t.props->>'state' = 'queued' and (t.props->>'scheduledFor')::timestamptz <= ${until}::timestamptz
        order by (t.props->>'scheduledFor')`)) as any[];
      return rows.map((r) => ({
        def: { taskId: r.id, title: r.title, workflowId: r.props.workflowId, projectId: r.props.projectId, runnerId: r.props.runnerId ?? "laptop", steps: r.props.steps, grantIds: [], mode: r.props.mode ?? "auto", projectWorkdir: r.props.projectWorkdir, priority: r.props.priority ?? 0, runnerAffinity: r.props.runnerAffinity ?? "fixed", budgetGbp: r.props.budgetGbp, deadline: r.props.deadline },
        signedGrantIds: r.ledger_status === "signed" ? r.grant_ids : undefined,
      }));
    },
    async materialiseChore({ choreId }) {
      const [ch] = (await db.execute(sql`select title, props from nodes where id = ${choreId} and type = 'chore'`)) as any[];
      if (!ch) return { skipped: "chore deleted" };
      if (ch.props.paused) return { skipped: "paused" };
      const snap = ch.props.def;
      const taskId = crypto.randomUUID();
      // Grants: ask the API, which owns ledger generation and signing (template => signed for auto/assist).
      const r = await fetch(`${apiUrl}/internal/materialise`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ choreId, taskId }) });
      if (!r.ok) throw new Error(`materialise ${r.status}`);
      const { grantIds, def } = (await r.json()) as any;
      return { def: { ...snap, ...def, taskId, grantIds } };
    },
    async sessionProject({ sessionId }) {
      const [s] = (await db.execute(sql`select props->>'projectId' as pid from nodes where id = ${sessionId}`)) as any[];
      return { projectId: s?.pid ?? undefined };
    },
    async progressInputs({ projectId }) {
      const [p] = (await db.execute(sql`select title, props from nodes where id = ${projectId} and type = 'project'`)) as any[];
      if (!p) return undefined;
      const context = await acts.projectContext({ projectId });
      const recent = (await db.execute(sql`select title, props from nodes where type = 'session' and props->>'projectId' = ${projectId} and props->>'outcome' is not null order by created_at desc limit 5`)) as any[];
      const recentSummaries = recent.map((r) => { const sm = r.props.summary ?? {}; return `${r.title}: ${r.props.outcome}; tools ${Object.keys(sm.tools ?? {}).join(",") || "none"}; parked ${(sm.parked ?? []).map((x: any) => `${x.tool} ${x.resolved}`).join(",") || "none"}; lessons: ${(r.props.lessons ?? []).slice(0, 2).join(" | ")}`; });
      return { projectTitle: p.title, goal: p.props.goal, context, recentSummaries, previous: p.props.progress, workdir: p.props.workdir, runnerId: p.props.runnerId ?? "laptop", memory: p.props.memory };
    },
    async storeProgress({ projectId, assessment }) {
      const [p] = (await db.execute(sql`select props from nodes where id = ${projectId}`)) as any[];
      const history = [...(p?.props?.progressHistory ?? []).slice(-9), { at: assessment.assessedAt, status: assessment.status, headline: assessment.headline, percent: assessment.percent }];
      // D6: merge memory. Union per list, drop anything in retire, cap each list.
      const prev = p?.props?.memory ?? { decisions: [], conventions: [], openQuestions: [] };
      const upd = assessment.memory;
      const retire = new Set((upd?.retire ?? []).map((x: string) => x.trim().toLowerCase()));
      const merge = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b].map((x) => x.trim()).filter((x) => x && !retire.has(x.toLowerCase())))].slice(-40);
      const memory = { decisions: merge(prev.decisions, upd?.decisions), conventions: merge(prev.conventions, upd?.conventions), openQuestions: merge(prev.openQuestions, upd?.openQuestions), updatedAt: new Date().toISOString() };
      const { memory: _m, ...rest } = assessment as any;
      await db.execute(sql`update nodes set props = props || ${JSON.stringify({ progress: rest, progressHistory: history, memory })}::jsonb, updated_at = now() where id = ${projectId}`);
    },
    async pickRunner({ requires }) {
      const rows = (await db.execute(sql`select title, props from nodes where type = 'runner' and (props->>'lastSeen')::timestamptz > now() - interval '2 minutes' order by (props->>'live')::int asc`)) as any[];
      const ok = rows.filter((r) => requires.every((t) => (r.props.tools ?? []).includes(t)));
      return ok[0]?.title ?? rows[0]?.title ?? undefined;
    },
    async startIndexing({ sessionId }) {
      const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
      const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
      await client.workflow.start("IndexWorkflow", { args: [{ sessionId }], taskQueue: CLOUD_QUEUE, workflowId: `index-${sessionId}` }).catch((e) => { if (!String(e).includes("already")) throw e; });
      await connection.close();
    },
  };
  return acts;
}
