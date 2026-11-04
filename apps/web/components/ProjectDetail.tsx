"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, money, cap, vendorTone } from "@/components/ui";

export function ProjectDetail({ id }: { id: string }) {
  const [d, setD] = useState<any>(null);
  const [all, setAll] = useState<any[]>([]);
  const load = () => Promise.all([get<any>(`/projects/${id}`), get<any>("/sessions")]).then(([x, s]) => { setD(x); setAll(s.sessions); });
  useEffect(() => { load(); }, [id]);
  if (!d) return <div className="p-6 text-[13px]">Loading</div>;
  const p = d.project;
  async function edit() {
    const workdir = window.prompt("Repo or folder path", p.props.workdir ?? "") ?? undefined;
    const goal = window.prompt("Goal", p.props.goal ?? "") ?? undefined;
    const defaultMode = window.prompt("Default mode: auto | assist | manual", p.props.defaultMode ?? "assist") ?? undefined;
    await post("/projects", { id, title: p.title, workdir: workdir || undefined, goal, defaultMode }); load();
  }
  async function bringIn(sid: string) { const prompt = window.prompt("Prompt for the new session that uses this imported context:", p.props.goal ?? ""); if (!prompt) return; await post(`/projects/${id}/continue`, { mode: p.props.defaultMode ?? "assist", prompt, from: [sid] }); window.location.href = "/"; }
  const others = all.filter((s) => s.props.projectId !== id && s.props.outcome).slice(0, 8);
  return (
    <>
      <Header title={p.title} sub={<span className="font-mono">{p.props.workdir ?? "scratch"}</span>}><Btn onClick={() => post(`/projects/${id}/assess`).then(load)}>Reassess progress</Btn><Btn onClick={edit}>Edit</Btn><Btn href="/today">Today</Btn></Header>
      <div className="p-6 grid grid-cols-[2fr_1fr] gap-5 items-start">
        <div className="flex flex-col gap-4">
          {p.props.goal && <Card><Eyebrow>Goal</Eyebrow><div className="text-[14px]">{p.props.goal}</div></Card>}
          {p.props.progress && (() => { const pr = p.props.progress; return (
            <Card accent={pr.status === "blocked" ? "red" : pr.status === "on_track" ? "green" : undefined}>
              <div className="flex items-center gap-2"><H2>Progress</H2><Pill tone={pr.status === "on_track" ? "green" : pr.status === "blocked" ? "red" : pr.status === "at_risk" ? "amber" : "grey"}>{pr.status.replace("_", " ")}{pr.percent != null ? ` ${pr.percent}%` : ""}</Pill><span className="ml-auto text-xs text-muted">{pr.assessedAt ? new Date(pr.assessedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}</span></div>
              <div className="text-[14px]">{pr.headline}</div>
              <div className="grid grid-cols-3 gap-4 text-[13px]">
                <div><Eyebrow>Done</Eyebrow>{pr.done.map((x: string, i: number) => <div key={i} className="text-ink-2">{x}</div>)}</div>
                <div><Eyebrow>In progress</Eyebrow>{pr.inProgress.map((x: string, i: number) => <div key={i} className="text-ink-2">{x}</div>)}</div>
                <div><Eyebrow>Blocked</Eyebrow>{pr.blocked.map((x: string, i: number) => <div key={i} className="text-red">{x}</div>)}{pr.blocked.length === 0 && <div className="text-muted">nothing</div>}</div>
              </div>
              <div><Eyebrow>Next steps</Eyebrow><ol className="text-[13px] list-decimal pl-5">{pr.nextSteps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ol></div>
              <div className="font-mono text-xs bg-card-alt rounded p-2.5 text-ink-2"><span className="text-muted">Suggested next prompt: </span>{pr.suggestedPrompt}</div>
              {pr.epics?.length > 0 && <div className="flex flex-wrap gap-1">{pr.epics.map((e: any, i: number) => <Pill key={i} tone={e.status === "done" ? "green" : e.status === "in_progress" ? "amber" : "grey"}>{e.title}</Pill>)}</div>}
            </Card>); })()}
          <Card><H2>Sessions</H2>
            <table className="w-full text-[13px]"><thead><tr className="text-left font-mono text-[10px] tracking-widest uppercase text-muted"><th className="py-1.5">When</th><th>Step</th><th>Vendor</th><th>Mode</th><th>State</th><th>Cost</th></tr></thead>
            <tbody>{d.sessions.map((s: any) => <tr key={s.id} className="border-t border-black/10"><td className="py-2"><a href={`/graph?node=${s.id}`} className="font-semibold">{new Date(s.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</a></td><td>{s.title.split(": ").pop()}</td><td><Pill tone={vendorTone(s.props.vendor)}>{cap(s.props.vendor ?? "?")}</Pill></td><td>{s.props.mode}</td><td className={s.props.state === "parked" ? "text-red" : ""}>{s.props.outcome ?? s.props.state}</td><td>{money(s.props.spendGbp)}</td></tr>)}</tbody></table>
            {d.sessions.length === 0 && <div className="text-[13px] text-ink-2">None yet.</div>}
          </Card>
          <Card><H2>Tasks</H2>{d.tasks.map((t: any) => <div key={t.id} className="flex items-center gap-2 text-[13px] border-t border-black/10 py-1.5 first:border-0"><span className="font-semibold">{t.title}</span><Pill tone={t.props.state === "awaiting_go_ahead" ? "amber" : t.props.state === "done" ? "green" : "grey"}>{t.props.state}</Pill><span className="text-muted">{t.props.mode}</span>{t.props.scheduledFor && <span className="text-muted">tonight {new Date(t.props.scheduledFor).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
            {t.props.state === "awaiting_go_ahead" && <span className="ml-auto flex gap-1.5"><Btn primary onClick={() => post(`/tasks/${t.id}/go`, { stepIndex: t.props.stepIndex, go: true }).then(load)}>Go: {t.props.stepName}</Btn><Btn onClick={() => post(`/tasks/${t.id}/go`, { stepIndex: t.props.stepIndex, go: false }).then(load)}>Stop</Btn></span>}</div>)}{d.tasks.length === 0 && <div className="text-[13px] text-ink-2">None yet.</div>}</Card>
        </div>
        <div className="flex flex-col gap-4">
          <Card accent="red"><H2>Grant template</H2><div className="text-[13px] text-ink-2">Standing consent for auto mode; assist parks outward actions anyway.</div><div className="font-mono text-[13px]">{(p.props.grantTemplate ?? []).map((g: any, i: number) => <div key={i} className="flex justify-between py-1 border-b border-black/10"><span>{g.action}</span><span className="text-green">allow{g.cap?.count ? `, ${g.cap.count}` : ""}</span></div>)}{!(p.props.grantTemplate ?? []).length && <div className="font-sans text-ink-2">Empty: in auto mode only step-declared actions are pre-authorised.</div>}</div></Card>
          <Card><H2>Bring in from another session</H2><div className="text-[13px] text-ink-2">Their prompt and lessons go into the next continuation pack; a derived_from edge is recorded.</div>{others.map((s) => <div key={s.id} className="flex items-center gap-2 text-[13px] border-t border-black/10 py-1.5"><span className="truncate"><b>{s.title}</b> <span className="text-muted">{s.props.lessons?.length ?? 0} lessons</span></span><span className="ml-auto"><Btn onClick={() => bringIn(s.id)}>Use</Btn></span></div>)}{others.length === 0 && <div className="text-[13px] text-ink-2">No completed sessions in other projects yet.</div>}</Card>
          {d.derived.length > 0 && <Card><Eyebrow>Derived from</Eyebrow>{d.derived.map((x: any) => <div key={x.id} className="text-[13px]">{x.title}</div>)}</Card>}
        </div>
      </div>
    </>
  );
}
