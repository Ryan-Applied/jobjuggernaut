"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, Stat, money, cap, vendorTone } from "@/components/ui";

export function Today() {
  const [projects, setProjects] = useState<any[]>([]);
  const [brief, setBrief] = useState<any>(null);
  const load = () => Promise.all([get<any>("/projects"), get<any>("/brief?hours=14")]).then(([p, b]) => { setProjects(p.projects); setBrief(b); });
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, []);

  async function newProject() {
    const title = window.prompt("Project name"); if (!title) return;
    const workdir = window.prompt("Repo or folder path on the runner (blank = scratch)") || undefined;
    const goal = window.prompt("Current goal (what should sessions continue towards?)") || undefined;
    await post("/projects", { title, workdir, goal, defaultMode: "assist" }); load();
  }
  async function cont(p: any, mode: "auto" | "assist" | "manual") {
    const prompt = window.prompt(`Continue "${p.title}" in ${mode} mode. Edit the prompt or accept:`, p.props.progress?.suggestedPrompt ?? p.props.goal ?? "") ?? undefined;
    if (prompt === undefined) return;
    await post(`/projects/${p.id}/continue`, { mode, prompt: prompt || undefined }); load();
  }
  async function tonight(p: any) {
    const at = new Date(); at.setHours(22, 0, 0, 0); if (at < new Date()) at.setDate(at.getDate() + 1);
    const prompt = window.prompt(`Queue "${p.title}" for tonight (auto). Prompt:`, p.props.goal ?? ""); if (!prompt) return;
    const r = await post<any>(`/projects/${p.id}/continue`, { mode: "auto", prompt, scheduledFor: at.toISOString() });
    alert(r.needsSignature ? "Queued. Sign its ledger under Approvals before 22:00." : "Queued for tonight."); load();
  }
  const t = brief?.totals;
  return (
    <>
      <Header title="Today" sub={brief ? `Window: last ${brief.window.hours} h. ${new Date().toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}` : ""}>
        <Btn href="/approvals">Approvals</Btn><Btn href="/drafts">Ingest</Btn><Btn primary onClick={newProject}>New project</Btn>
      </Header>
      <div className="p-6 flex flex-col gap-5">
        {t && <div className="grid grid-cols-6 gap-3">
          <Stat label="Completed" value={<span className="text-green">{t.completed}</span>} />
          <Stat label="Parked for you" value={t.parked} accent={t.parked > 0} />
          <Stat label="Awaiting go-ahead" value={t.awaiting} accent={t.awaiting > 0} />
          <Stat label="Partial or skipped" value={t.partial} />
          <Stat label="Spent of cap" value={<>{money(t.spendGbp)} <span className="text-[13px] font-normal text-muted">of {money(t.capGbp)}</span></>} />
          <Stat label="Grants used" value={<>{t.grantsUsed} <span className="text-[13px] font-normal text-muted">of {t.grantsTotal}{t.delegated ? `, ${t.delegated} widened` : ""}</span></>} />
        </div>}
        <div className="grid grid-cols-2 gap-4">
          {projects.map((p) => { const ls = p.last_session; const lp = ls?.props ?? {}; return (
            <Card key={p.id} accent={p.parked > 0 || p.awaiting > 0 ? "red" : undefined}>
              <div className="flex items-center gap-2"><a href={`/projects/${p.id}`} className="font-bold text-[15px]">{p.title}</a><Pill>{p.props.defaultMode ?? "assist"}</Pill>{p.running > 0 && <Pill tone="green">{p.running} running</Pill>}{p.parked > 0 && <Pill tone="red">{p.parked} parked</Pill>}{p.awaiting > 0 && <Pill tone="amber">go-ahead needed</Pill>}<span className="ml-auto text-xs text-muted font-mono">{p.props.workdir ?? "scratch"}</span></div>
              {p.props.goal && <div className="text-[13px] text-ink-2"><span className="text-muted">Goal:</span> {p.props.goal}</div>}
              {p.props.progress && <div className="flex items-center gap-2 text-[13px]"><Pill tone={p.props.progress.status === "on_track" ? "green" : p.props.progress.status === "blocked" ? "red" : p.props.progress.status === "at_risk" ? "amber" : "grey"}>{p.props.progress.status.replace("_", " ")}{p.props.progress.percent != null ? ` ${p.props.progress.percent}%` : ""}</Pill><span className="text-ink-2">{p.props.progress.headline}</span></div>}
              {p.props.progress?.nextSteps?.[0] && <div className="text-[13px]"><span className="text-muted">Next:</span> {p.props.progress.nextSteps[0]}</div>}
              <div className="font-mono text-xs rounded px-2.5 py-2 bg-card-alt text-ink-2">
                {ls ? <>{new Date(ls.created_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}  {lp.state}{lp.outcome ? ` (${lp.outcome})` : ""}  {lp.lastEvent ? lp.lastEvent.slice(0, 70) : ""}{lp.parkedGap ? ` ${lp.parkedGap}` : ""}</> : "No sessions yet."}
              </div>
              {(lp.lessons ?? []).slice(0, 2).map((l: string, i: number) => <div key={i} className="text-[13px] text-ink-2">{l}</div>)}
              <div className="flex gap-4 text-xs text-muted"><span>{p.sessions} sessions</span><span>{money(Number(p.spend_24h))} last 24 h</span></div>
              <div className="flex gap-1.5 flex-wrap"><Btn primary onClick={() => cont(p, "auto")}>Continue auto</Btn><Btn onClick={() => cont(p, "assist")}>Assist</Btn><Btn onClick={() => cont(p, "manual")}>Manual</Btn><Btn onClick={() => tonight(p)}>Queue tonight</Btn></div>
            </Card>); })}
          {projects.length === 0 && <div className="col-span-2 text-[13px] text-ink-2">No projects yet. A project is a name, a repo or folder to work in, a goal and a default mode. Sessions, chores and lessons hang off it.</div>}
        </div>
        {brief?.proposals?.length > 0 && <Card><H2>Proposals waiting</H2>{brief.proposals.slice(0, 5).map((p: any) => <div key={p.id} className="text-[13px]"><b>{p.title}</b> <span className="text-muted">{p.props.kind}</span></div>)}<a href="/proposals" className="text-[13px] font-semibold text-red">Review</a></Card>}
      </div>
    </>
  );
}
