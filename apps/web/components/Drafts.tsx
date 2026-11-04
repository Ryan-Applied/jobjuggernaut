"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Header, Btn, Pill } from "@/components/ui";
export function Drafts() {
  const [rows, setRows] = useState<any[]>([]); const [busy, setBusy] = useState<string | null>(null);
  const load = () => get<any>("/drafts").then((r) => setRows(r.drafts));
  useEffect(() => { load(); }, []);
  async function ingestProject() {
    const workdir = window.prompt("Repo or folder path on the runner (blank for a research/planning project):") ?? null; if (workdir === null) return;
    const hint = window.prompt("Hint for the LLM (what is this, what should sessions work towards?)") ?? undefined;
    setBusy("Reading the folder and drafting the project…");
    const r = await post<any>("/ingest/project", { workdir: workdir || undefined, hint: hint || undefined }); setBusy(null);
    if (r.draftId) window.location.href = `/drafts/${r.draftId}`; else alert(JSON.stringify(r));
  }
  async function ingestWorkflow() {
    const text = window.prompt("Paste a runbook, checklist or a paragraph describing the procedure (or a file path on the runner prefixed with path:):"); if (!text) return;
    setBusy("Drafting the workflow…");
    const r = await post<any>("/ingest/workflow", text.startsWith("path:") ? { path: text.slice(5).trim() } : { text }); setBusy(null);
    if (r.draftId) window.location.href = `/drafts/${r.draftId}`; else alert(JSON.stringify(r));
  }
  return (<>
    <Header title="Ingest" sub="Point the platform at a folder or a procedure; the LLM drafts it, you accept."><Btn onClick={ingestWorkflow}>Ingest workflow</Btn><Btn primary onClick={ingestProject}>Ingest project</Btn></Header>
    <div className="p-6 flex flex-col gap-4">
      {busy && <div className="text-[13px] text-ink-2">{busy}</div>}
      <div className="grid grid-cols-2 gap-4">
        {rows.map((d) => <Card key={d.id}><div className="flex items-center gap-2"><a href={`/drafts/${d.id}`} className="font-bold">{d.title}</a><Pill>{d.props.kind}</Pill><span className="ml-auto text-xs text-muted font-mono">{d.props.workdir ?? ""}</span></div><div className="text-[13px] text-ink-2">{d.props.draft.goal ?? d.props.draft.description ?? ""}</div><div className="text-[13px] text-muted">{(d.props.draft.continueSteps ?? d.props.draft.steps ?? []).length} steps</div></Card>)}
        {rows.length === 0 && !busy && <div className="col-span-2 text-[13px] text-ink-2">No drafts waiting.</div>}
      </div>
    </div></>);
}
