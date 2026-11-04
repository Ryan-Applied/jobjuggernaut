"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, vendorTone, money, cap } from "@/components/ui";
import { ForceGraph, type GNode, type GEdge } from "@/components/ForceGraph";

type Node = { id: string; type: string; title: string; props: any };
type Data = { node: Node; neighbours: Record<string, Array<{ id: string; type: string; title: string; weight?: number }>>; similar: Array<{ id: string; title: string; weight: number; props: any }>; transcriptTail: any[] };

const EDGE_LABEL: Record<string, string> = { similar_to: "Similar sessions", part_of: "Part of", uses_skill: "Skills", touched: "Connectors", ran_on: "Runner", authorised_by: "Grants", required_approval: "Approvals", produced: "Artifacts", spawned: "Sub-agents", relates_to: "Related", superseded_by: "Supersedes" };

export function GraphExplorer({ initial }: { initial?: string }) {
  const [id, setId] = useState<string | undefined>(initial);
  const [data, setData] = useState<Data | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [view, setView] = useState<"graph" | "list">("graph");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [nudgeText, setNudgeText] = useState("");

  useEffect(() => { get<{ sessions: any[] }>("/sessions").then((r) => { setRecent(r.sessions); if (!id && r.sessions[0]) setId(r.sessions[0].id); }); }, []);
  useEffect(() => { if (id) get<Data>(`/graph/${id}`).then(setData); }, [id]);

  const n = data?.node; const p = n?.props ?? {};
  return (
    <>
      <Header title="Graph" sub={n ? `${cap(n.type)}: ${n.title}` : "Pick a node"}>
        <select className="h-8 px-2 rounded border border-black/15 bg-card text-[13px]" value={id ?? ""} onChange={(e) => setId(e.target.value)}>
          {recent.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </Header>
      {data && (
        <div className="p-6 grid grid-cols-[250px_minmax(0,1fr)_250px] gap-5 items-start">
          <div className="flex flex-col gap-4">
            <Card><Eyebrow>Selected node</Eyebrow><div className="font-bold leading-tight">{n!.title}</div>
              <div className="text-[13px] text-ink-2">{cap(n!.type)}{p.vendor ? `, ${p.vendor}` : ""}{p.runnerId ? `, ${p.runnerId}` : ""}{p.state ? `, ${p.state}` : ""}</div>
              {n!.type === "session" && <div className="grid grid-cols-2 gap-1 text-[13px]"><span className="text-muted">Tokens</span><span className="text-right">{((p.tokensIn ?? 0) + (p.tokensOut ?? 0)).toLocaleString()}</span><span className="text-muted">Cost</span><span className="text-right">{money(p.spendGbp)}</span><span className="text-muted">Indexed</span><span className="text-right">{p.indexedAt ? "yes" : "pending"}</span></div>}
            </Card>
            {n!.type === "session" && (p.state === "running" || p.state === "parked") && <Card><Eyebrow>Nudge the session</Eyebrow><textarea className="p-2 rounded border border-black/15 text-[13px] min-h-[56px]" placeholder="Follow-up for the running session (interactive sessions only)" value={nudgeText} onChange={(e) => setNudgeText(e.target.value)} /><div className="flex gap-1.5"><Btn primary onClick={() => post(`/sessions/${n!.id}/send`, { text: nudgeText }).then(() => setNudgeText(""))}>Send</Btn><Btn onClick={() => post(`/sessions/${n!.id}/send`, { text: nudgeText || "Wrap up and summarise.", final: true }).then(() => setNudgeText(""))}>Send and close</Btn></div></Card>}
            {p.workdir && <Card><Eyebrow>Workdir</Eyebrow><div className="font-mono text-xs break-all">{p.workdir}</div>{p.branch && <div className="text-[13px] text-ink-2">branch {p.branch}{p.worktree ? `, ${p.worktree.kept ? "kept: " + p.worktree.reason : "cleaned"}` : ""}</div>}</Card>}
            {data.transcriptTail.length > 0 && <Card><Eyebrow>Transcript tail</Eyebrow><div className="font-mono text-xs text-ink-2 bg-card-alt rounded p-2.5 flex flex-col gap-1">{data.transcriptTail.map((e, i) => <div key={i} className="truncate">{e.type} {e.tool ?? e.text?.slice(0, 50) ?? e.summary?.slice(0, 50) ?? ""}</div>)}</div><a href="/" className="text-[13px] font-semibold text-red">Open sessions</a></Card>}
          </div>

          <Card className="min-h-[520px]">
            <div className="flex items-center gap-2 flex-wrap"><H2>Neighbourhood</H2><span className="text-[13px] text-muted">{Object.values(data.neighbours).flat().length} edges</span>
              <span className="ml-auto flex gap-1">{(["graph", "list"] as const).map((v) => <button key={v} onClick={() => setView(v)} className={`h-7 px-2.5 rounded-full text-xs ${view === v ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`}>{v}</button>)}</span></div>
            {view === "graph" && <>
              <div className="flex flex-wrap gap-1">{Object.keys(data.neighbours).map((edge) => <button key={edge} onClick={() => { const h = new Set(hidden); h.has(edge) ? h.delete(edge) : h.add(edge); setHidden(h); }} className={`h-6 px-2 rounded-full text-[11px] ${hidden.has(edge) ? "bg-card border border-black/15 text-muted line-through" : "bg-black/5"}`}>{EDGE_LABEL[edge] ?? edge}</button>)}</div>
              <ForceGraph centre={n!.id} hidden={hidden} onPick={setId}
                nodes={[{ id: n!.id, type: n!.type, title: n!.title } as GNode, ...Object.values(data.neighbours).flat().map((it: any) => ({ id: it.id, type: it.type, title: it.title, weight: it.weight }))].filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)}
                edges={Object.entries(data.neighbours).flatMap(([edge, items]) => (items as any[]).map((it) => ({ src: n!.id, dst: it.id, type: edge, weight: it.weight } as GEdge)))} />
            </>}
            {view === "list" && <div className="flex flex-col gap-4">
              {Object.entries(data.neighbours).map(([edge, items]) => (
                <div key={edge}><Eyebrow>{EDGE_LABEL[edge] ?? edge}</Eyebrow>
                  <div className="flex flex-wrap gap-2 mt-1.5">{items.map((it) => (
                    <button key={it.id + edge} onClick={() => setId(it.id)} className={`px-3 py-1.5 rounded-lg text-[13px] text-left border ${it.type === "session" ? "bg-card-alt border-transparent" : it.type === "workflow" || it.type === "skill" ? "bg-card border-red/40 rounded-full" : "bg-card border-black/15"}`}>
                      <span className="font-semibold">{it.title}</span>{it.weight != null && <span className="text-muted ml-1.5 font-mono text-xs">{edge === "similar_to" ? Number(it.weight).toFixed(2) : `x${it.weight}`}</span>}
                    </button>))}</div>
                </div>))}
              {Object.keys(data.neighbours).length === 0 && <div className="text-[13px] text-ink-2">No edges yet. Edges appear once the indexer has processed this session.</div>}
            </div>}
          </Card>

          <div className="flex flex-col gap-4">
            <Card><Eyebrow>Lessons</Eyebrow>{(p.lessons ?? []).length ? (p.lessons as string[]).map((l, i) => <div key={i} className="text-[13px] text-ink-2">{l}</div>) : <div className="text-[13px] text-ink-2">None recorded.</div>}</Card>
            {data.similar.length > 0 && <Card><Eyebrow>From similar sessions</Eyebrow>{data.similar.map((s) => <button key={s.id} onClick={() => setId(s.id)} className="text-left text-[13px]"><span className="font-semibold">{s.title}</span> <span className="text-muted font-mono text-xs">{Number(s.weight).toFixed(2)}</span><div className="text-ink-2">{s.props?.outcome ?? s.props?.state}, {money(s.props?.spendGbp)}</div></button>)}</Card>}
            {p.workflowId && <Card><Eyebrow>Workflow</Eyebrow><Btn href={`/workflows/${p.workflowId}`}>Open workflow</Btn></Card>}
          </div>
        </div>
      )}
    </>
  );
}
