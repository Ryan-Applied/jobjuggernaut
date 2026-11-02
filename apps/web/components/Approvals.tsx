"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Eyebrow, H2, Header, Btn, Pill, money } from "@/components/ui";

export function Approvals() {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [signed, setSigned] = useState<any[]>([]);
  const [parked, setParked] = useState<any[]>([]);
  const [awaiting, setAwaiting] = useState<any[]>([]);
  const [queued, setQueued] = useState<any[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = () => Promise.all([get<any>("/ledgers?status=draft"), get<any>("/ledgers?status=signed"), get<any>("/parked"), get<any>("/tasks?state=awaiting_go_ahead"), get<any>("/tasks?state=queued")])
    .then(([d, s, p, a, q]) => { setDrafts(d.ledgers); setSigned(s.ledgers); setParked(p.parked); setAwaiting(a.tasks); setQueued(q.tasks); if (!sel && d.ledgers[0]) setSel(d.ledgers[0].id); });
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  const ledger = drafts.find((l) => l.id === sel) ?? drafts[0];
  const unsigned = queued.filter((t) => !drafts.some((l) => l.task_id === t.id) && !signed.some((l) => l.task_id === t.id));

  async function generate(taskId: string) { await post("/ledgers/generate", { taskId }); load(); }
  async function sign(l: any, edits: any[] = []) { await post(`/ledgers/${l.id}/sign`, { grants: edits }); setSel(null); load(); }
  async function signAll() { for (const l of drafts) await post(`/ledgers/${l.id}/sign`, {}); load(); }
  async function decide(p: any, mode: string) { await post(`/approvals/${p.callId}`, { sessionId: p.sessionId, mode }); load(); }
  async function runBatchNow() { await post("/overnight/run", { signDeadlineMinutes: 1 }); alert("Overnight batch started now; signed tasks run, unsigned skip after 1 minute."); }

  return (
    <>
      <Header title="Approvals" sub="Grants expire 08:00">
        <Btn onClick={runBatchNow}>Run overnight batch now</Btn>{drafts.length > 0 && <Btn primary onClick={signAll}>Sign {drafts.length} unsigned</Btn>}
      </Header>
      <div className="p-6 grid grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        <div className="flex flex-col gap-2">
          <Eyebrow>Queued for tonight, {queued.length}</Eyebrow>
          {queued.map((t) => { const d = drafts.find((l) => l.task_id === t.id); const s = signed.find((l) => l.task_id === t.id); return (
            <button key={t.id} onClick={() => d && setSel(d.id)} className={`text-left bg-card rounded-lg p-3 shadow-sm flex flex-col gap-1 ${d && sel === d.id ? "border-l-[3px] border-red" : ""}`}>
              <div className="flex items-center gap-2"><span className="text-sm font-semibold">{t.title}</span><span className={`ml-auto text-xs font-semibold ${s ? "text-green" : "text-amber"}`}>{s ? "Signed" : d ? "Unsigned" : "No ledger"}</span></div>
              <div className="text-xs text-ink-2">{t.props.mode}, {new Date(t.props.scheduledFor).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}{d?.never_pre_authorised?.length ? `, ${d.never_pre_authorised.length} cannot be pre-authorised` : ""}</div>
              {!d && !s && <span><Btn onClick={() => generate(t.id)}>Generate ledger</Btn></span>}
            </button>); })}
          {queued.length === 0 && <div className="text-[13px] text-ink-2 p-2">Nothing queued. Use "Queue tonight" on a project.</div>}
          <div className="mt-3 p-3 bg-card-alt rounded-lg text-[13px] text-ink-2">A grant is scope plus a cap plus an expiry. Nothing in a ledger is "allow all". Anything the planner did not list parks on contact.</div>
        </div>

        <div className="flex flex-col gap-4">
          {ledger && <LedgerCard l={ledger} onSign={sign} onSkip={async () => { await post(`/ledgers/${ledger.id}/skip`); setSel(null); load(); }} />}
          {awaiting.length > 0 && <Card accent="red"><div className="flex items-center gap-2"><H2>Awaiting your go-ahead</H2><span className="text-xs text-red font-mono">{awaiting.length}</span></div>
            {awaiting.map((t) => <div key={t.id} className="flex items-center gap-3 text-[13px] border-t border-black/10 py-2"><div><div className="font-semibold">{t.title}</div><div className="text-ink-2">Assist mode. Next step: {t.props.stepName}</div></div><span className="ml-auto flex gap-1.5"><Btn primary onClick={() => post(`/tasks/${t.id}/go`, { stepIndex: t.props.stepIndex, go: true }).then(load)}>Go</Btn><Btn onClick={() => post(`/tasks/${t.id}/go`, { stepIndex: t.props.stepIndex, go: false }).then(load)}>Stop here</Btn></span></div>)}</Card>}
          <Card><div className="flex items-center gap-2"><H2>Parked now</H2><span className="text-xs text-red font-mono">{parked.length} waiting</span><span className="ml-auto text-xs text-muted">Also sent to Slack when configured</span></div>
            <div className="grid grid-cols-2 gap-3">{parked.map((p) => <div key={p.callId} className="p-3.5 rounded-lg bg-card-alt flex flex-col gap-2"><div className="text-sm font-semibold">{p.tool}</div><div className="text-[13px] text-ink-2">{p.title}. {p.gap}. {p.at ? `Parked ${Math.round((Date.now() - Date.parse(p.at)) / 60000)} min.` : ""}</div><div className="flex gap-1.5 flex-wrap"><Btn primary onClick={() => decide(p, "once")}>Approve once</Btn><Btn onClick={() => decide(p, "widen")}>Add to grant</Btn><Btn onClick={() => decide(p, "deny")}>Deny</Btn></div></div>)}</div>
            {parked.length === 0 && <div className="text-[13px] text-ink-2">Nothing parked.</div>}</Card>
        </div>
      </div>
    </>
  );
}

function LedgerCard({ l, onSign, onSkip }: { l: any; onSign: (l: any, edits: any[]) => void; onSkip: () => void }) {
  const [edits, setEdits] = useState<Record<string, any>>({});
  const grants = l.grants.filter((g: any) => !edits[g.id]?.remove);
  return (
    <Card>
      <div className="flex items-start gap-4"><div><Eyebrow>Ledger for</Eyebrow><h2 className="m-0 text-2xl font-bold leading-tight">{l.title}</h2><div className="text-[13px] text-ink-2">{l.task.mode} mode, {new Date(l.task.scheduledFor).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}, {(l.task.steps ?? []).length} steps</div></div>
        <div className="ml-auto flex flex-col items-end gap-1">{l.never_pre_authorised?.length > 0 && <Pill tone="amber">{l.never_pre_authorised.length} actions cannot be pre-authorised</Pill>}<span className="text-xs text-muted">Expires {new Date(l.expires_at).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span></div></div>
      <table className="w-full text-[14px]"><thead><tr className="text-left font-mono text-[10px] tracking-widest uppercase text-muted"><th className="py-2">Intended action</th><th>Scope</th><th>Cap</th><th>Pre-authorise</th></tr></thead>
        <tbody>
          {l.grants.map((g: any) => <tr key={g.id} className={`border-t border-black/10 ${edits[g.id]?.remove ? "opacity-40" : ""}`}><td className="py-2.5 font-semibold">{g.action}</td><td className="font-mono text-[13px]">{Object.keys(g.scope ?? {}).length ? JSON.stringify(g.scope) : "any"}</td>
            <td className="font-mono text-[13px]">{g.action === "spend" ? <input className="w-20 h-8 px-2 rounded border border-black/15" defaultValue={g.cap?.gbp} onChange={(e) => setEdits({ ...edits, [g.id]: { id: g.id, cap: { gbp: Number(e.target.value) } } })} /> : g.cap?.count ? <input className="w-16 h-8 px-2 rounded border border-black/15" defaultValue={g.cap.count} onChange={(e) => setEdits({ ...edits, [g.id]: { id: g.id, cap: { count: Number(e.target.value) } } })} /> : "unbounded"}</td>
            <td><label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="w-4 h-4 accent-red" checked={!edits[g.id]?.remove} onChange={(e) => setEdits({ ...edits, [g.id]: { id: g.id, remove: !e.target.checked } })} />Allow</label></td></tr>)}
          {(l.never_pre_authorised ?? []).map((n: any) => <tr key={n.action} className="border-t border-black/10 bg-red/5"><td className="py-2.5"><div className="font-semibold">{n.action}</div><div className="text-xs text-red">{n.reason}</div></td><td className="font-mono text-[13px]">as declared</td><td></td><td className="text-[13px] text-red font-semibold">Will park and ask</td></tr>)}
        </tbody></table>
      <div className="flex items-center gap-4 pt-1"><div className="text-[13px] text-ink-2">Anything not listed parks on contact and pings Slack.</div><div className="ml-auto flex gap-2"><Btn onClick={onSkip}>Skip tonight</Btn><Btn primary onClick={() => onSign(l, Object.values(edits))}>Sign ledger</Btn></div></div>
    </Card>
  );
}
