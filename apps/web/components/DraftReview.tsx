"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, vendorTone, cap } from "@/components/ui";

export function DraftReview({ id }: { id: string }) {
  const [d, setD] = useState<any>(null);
  const [edits, setEdits] = useState<any>({});
  useEffect(() => { get<any>("/drafts").then((r) => setD(r.drafts.find((x: any) => x.id === id))); }, [id]);
  if (!d) return <div className="p-6 text-[13px]">Loading, or already decided.</div>;
  const v = { ...d.props.draft, ...edits }; const isProject = d.props.kind === "project";
  const steps: any[] = isProject ? v.continueSteps : v.steps;
  const setStep = (i: number, patch: any) => { const arr = steps.map((s, j) => (j === i ? { ...s, ...patch } : s)); setEdits({ ...edits, [isProject ? "continueSteps" : "steps"]: arr }); };
  async function accept(createChore: boolean) {
    const r = await post<any>(`/drafts/${id}/accept`, { edits, createChore });
    window.location.href = r.kind === "project" ? `/projects/${r.id}` : `/workflows/${r.id}`;
  }
  return (<>
    <Header title={`Review draft: ${v.title}`} sub={<Pill>{d.props.kind}</Pill>}>
      <Btn onClick={() => post(`/drafts/${id}/reject`).then(() => (window.location.href = "/drafts"))}>Reject</Btn>
      {v.suggestedChore && <Btn onClick={() => accept(true)}>Accept and schedule ({v.suggestedChore.cron})</Btn>}
      <Btn primary onClick={() => accept(false)}>Accept</Btn>
    </Header>
    <div className="p-6 grid grid-cols-[2fr_1fr] gap-5 items-start">
      <div className="flex flex-col gap-4">
        <Card>
          <Eyebrow>Title</Eyebrow><input className="h-9 px-3 rounded border border-black/15 text-[15px] font-bold" value={v.title} onChange={(e) => setEdits({ ...edits, title: e.target.value })} />
          {isProject ? <><Eyebrow>Goal</Eyebrow><textarea className="p-3 rounded border border-black/15 text-[14px] min-h-[60px]" value={v.goal} onChange={(e) => setEdits({ ...edits, goal: e.target.value })} /><div className="text-[13px] text-ink-2">{v.summary}</div></>
            : <><Eyebrow>Description</Eyebrow><textarea className="p-3 rounded border border-black/15 text-[14px] min-h-[60px]" value={v.description ?? ""} onChange={(e) => setEdits({ ...edits, description: e.target.value })} /></>}
          {isProject && <div className="flex items-center gap-2 text-[13px]"><span className="text-muted">Default mode</span>{["auto", "assist", "manual"].map((m) => <button key={m} onClick={() => setEdits({ ...edits, defaultMode: m })} className={`h-7 px-2.5 rounded-full text-xs ${v.defaultMode === m ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`}>{m}</button>)}</div>}
        </Card>
        <Card><H2>Steps</H2>
          {steps.map((s, i) => <div key={i} className="flex flex-col gap-1.5 border-t border-black/10 pt-3 first:border-0 first:pt-0">
            <div className="flex items-center gap-2"><Eyebrow>{i + 1}</Eyebrow><input className="h-8 px-2 rounded border border-black/15 text-[13px] font-semibold" value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} /><Pill tone={vendorTone(s.preferredVendor ?? "claude")}>{cap(s.preferredVendor ?? "claude")}</Pill>{s.reviewerOfPrevious && <Pill tone="green">reviewer</Pill>}<span className="ml-auto text-xs text-muted">cap £{s.maxCostGbp}</span></div>
            <textarea className="p-2.5 rounded border border-black/15 text-[13px] min-h-[64px]" value={s.prompt} onChange={(e) => setStep(i, { prompt: e.target.value })} />
            <div className="flex flex-wrap gap-1 text-xs">{(s.intendedActions ?? []).map((a: any, k: number) => <Pill key={k}>{a.tool}{a.cap?.count ? ` ×${a.cap.count}` : ""}{Object.keys(a.scope ?? {}).length ? ` ${JSON.stringify(a.scope)}` : ""}</Pill>)}{(s.skills ?? []).map((k: string) => <Pill key={k} tone="blue">{k}</Pill>)}{(s.connectors ?? []).map((k: string) => <Pill key={k} tone="amber">{k}</Pill>)}</div>
          </div>)}
        </Card>
      </div>
      <div className="flex flex-col gap-4">
        <Card accent="red"><H2>Grant template</H2><div className="text-[13px] text-ink-2">Standing consent for auto mode. The LLM is told to keep this read-only and local.</div><div className="font-mono text-[13px]">{(v.grantTemplate ?? []).map((g: any, i: number) => <div key={i} className="flex justify-between py-1 border-b border-black/10"><span>{g.action}</span><span className="text-green">allow{g.cap?.count ? `, ${g.cap.count}` : ""}</span></div>)}</div></Card>
        {isProject && v.epics?.length > 0 && <Card><H2>Epics found</H2>{v.epics.map((e: any, i: number) => <div key={i} className="text-[13px]"><Pill tone={e.status === "done" ? "green" : e.status === "in_progress" ? "amber" : "grey"}>{e.status}</Pill> {e.title}</div>)}</Card>}
        {v.risks?.length > 0 && <Card><H2>Risks</H2>{v.risks.map((r: string, i: number) => <div key={i} className="text-[13px] text-ink-2">{r}</div>)}</Card>}
        {v.suggestedChore && <Card><H2>Suggested chore</H2><div className="font-mono text-[13px]">{v.suggestedChore.cron} <span className="text-muted">{v.suggestedChore.mode}</span></div><div className="text-[13px] text-ink-2">{v.suggestedChore.reason}</div></Card>}
        <Card><Eyebrow>Evidence</Eyebrow><div className="text-[13px] text-ink-2">{(v.evidence ?? []).join(", ") || "hint only"}</div></Card>
      </div>
    </div></>);
}
