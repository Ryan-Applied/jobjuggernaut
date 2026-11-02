"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, vendorTone, money, cap } from "@/components/ui";

export function WorkflowDetail({ id }: { id: string }) {
  const [d, setD] = useState<any>(null);
  const load = () => get<any>(`/workflows/${id}`).then(setD);
  useEffect(() => { load(); }, [id]);
  if (!d) return <div className="p-6 text-[13px] text-ink-2">Loading</div>;
  const w = d.workflow; const steps: any[] = w.props.steps ?? []; const template: any[] = w.props.grantTemplate ?? [];
  async function runNow() { await post("/tasks", { workflowId: id }); window.location.href = "/"; }
  async function queueTonight() { const at = new Date(); at.setHours(22, 0, 0, 0); if (at < new Date()) at.setDate(at.getDate() + 1); await post("/tasks", { workflowId: id, scheduledFor: at.toISOString() }); alert("Queued for tonight. Sign its ledger under Approvals."); }
  async function decide(pid: string, dec: "accept" | "reject") { await post(`/proposals/${pid}/${dec}`); load(); }
  async function addChore() {
    const cron = window.prompt("Cron (e.g. 30 7 * * 1-5 for 07:30 weekdays)", "30 7 * * 1-5"); if (!cron) return;
    await post("/chores", { workflowId: id, cron }); load();
  }
  return (
    <>
      <Header title={`Workflow: ${w.title}`} sub={d.chores.length ? <Pill tone="green">Chore</Pill> : undefined}>
        <Btn onClick={addChore}>Make it a chore</Btn><Btn onClick={queueTonight}>Queue for tonight</Btn><Btn primary onClick={runNow}>Run now</Btn>
      </Header>
      <div className="p-6 flex flex-col gap-5">
        <Card><div className="flex items-center gap-3"><H2>Steps</H2><span className="text-[13px] text-muted">Each step names its agent, skills, connectors and intended actions. The planner builds the ledger from these.</span></div>
          <div className="flex gap-0 overflow-x-auto">
            {steps.map((s, i) => (<div key={i} className="flex items-stretch">
              <div className="w-56 p-3.5 bg-card-alt rounded-lg flex flex-col gap-1.5"><Eyebrow>{i + 1} {s.name}</Eyebrow><div className="text-[13px] text-ink-2 line-clamp-3">{s.prompt}</div>
                <div className="flex flex-wrap gap-1 mt-auto"><Pill tone={vendorTone(s.preferredVendor ?? "claude")}>{cap(s.preferredVendor ?? "claude")}</Pill>{(s.skills ?? []).map((k: string) => <Pill key={k}>{k}</Pill>)}{(s.intendedActions ?? []).map((a: any) => <Pill key={a.tool} tone="grey">{a.tool}</Pill>)}</div></div>
              {i < steps.length - 1 && <div className="w-6 flex items-center justify-center text-muted">›</div>}
            </div>))}
            {steps.length === 0 && <div className="text-[13px] text-ink-2">No definition. Runs so far were ad hoc; add steps via POST /workflows.</div>}
          </div></Card>

        <div className="grid grid-cols-[1fr_2fr_1fr] gap-5 items-start">
          <div className="flex flex-col gap-4">
            <Card><H2>Chore schedule</H2>{d.chores.length ? d.chores.map((c: any) => <div key={c.id} className="text-[13px]"><div className="font-mono">{c.props.cron}</div><div className="text-ink-2">{c.props.paused ? "paused" : "active"}, runner {c.props.runnerId ?? w.props.runnerId ?? "laptop"}{c.props.autoSign ? ", auto-signed template" : ""}</div></div>) : <div className="text-[13px] text-ink-2">Not scheduled.</div>}</Card>
            <Card><H2>Skills</H2>{d.skills.map((s: any) => <div key={s.id} className="text-[13px]"><b>{s.title}</b> <span className="text-muted">v{s.props.version ?? 1}</span>{s.props.pendingLessons?.length ? <div className="text-amber text-xs">{s.props.pendingLessons.length} accepted lessons pending a PR</div> : null}</div>)}{d.skills.length === 0 && <div className="text-[13px] text-ink-2">None linked.</div>}</Card>
          </div>
          <Card><H2>Run history</H2>
            <table className="w-full text-[13px]"><thead><tr className="text-left font-mono text-[10px] tracking-widest uppercase text-muted"><th className="py-1.5">Run</th><th>Vendor</th><th>Cost</th><th>Parked</th><th>Outcome</th></tr></thead>
              <tbody>{d.runs.map((r: any) => <tr key={r.id} className="border-t border-black/10"><td className="py-2"><a href={`/graph?node=${r.id}`} className="font-semibold">{new Date(r.created_at).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</a></td><td><Pill tone={vendorTone(r.props.vendor)}>{cap(r.props.vendor ?? "?")}</Pill></td><td>{money(r.props.spendGbp)}</td><td className={r.props.summary?.parked?.length ? "text-red" : ""}>{r.props.summary?.parked?.length ?? (r.props.state === "parked" ? 1 : 0)}</td><td>{r.props.outcome ?? r.props.state}</td></tr>)}</tbody></table>
            {d.runs.length === 0 && <div className="text-[13px] text-ink-2">No runs yet.</div>}
          </Card>
          <div className="flex flex-col gap-4">
            <Card accent="red"><div className="flex items-center gap-2"><H2>Grant template</H2><span className="ml-auto text-xs text-muted">v{w.props.templateVersion ?? 1}</span></div>
              <div className="text-[13px] text-ink-2">What every run may do without asking.</div>
              <div className="font-mono text-[13px] flex flex-col">{template.map((g, i) => <div key={i} className="flex justify-between py-1.5 border-b border-black/10"><span>{g.action}{Object.keys(g.scope ?? {}).length ? ` ${JSON.stringify(g.scope)}` : ""}</span><span className="text-green">allow{g.cap?.count ? `, ${g.cap.count}` : ""}{g.cap?.gbp ? `, ${money(g.cap.gbp)}` : ""}</span></div>)}{template.length === 0 && <div className="text-ink-2 font-sans">Empty: every tool call will park. Accept proposals or edit via POST /workflows.</div>}</div></Card>
            <Card><H2>Proposals</H2>{d.proposals.map((p: any) => <div key={p.id} className="flex flex-col gap-1.5 text-[13px] border-t border-black/10 pt-2 first:border-0 first:pt-0"><div className="font-semibold">{p.title}</div><div className="text-ink-2">{p.props.kind === "skill_edit" ? (p.props.lessons ?? []).join(" ") : `Evidence: ${p.props.evidence} of ${p.props.of} runs`}</div><div className="flex gap-1.5"><Btn primary onClick={() => decide(p.id, "accept")}>Accept</Btn><Btn onClick={() => decide(p.id, "reject")}>Reject</Btn></div></div>)}{d.proposals.length === 0 && <div className="text-[13px] text-ink-2">Nothing proposed.</div>}</Card>
          </div>
        </div>
      </div>
    </>
  );
}
