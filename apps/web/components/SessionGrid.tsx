"use client";
import { useEffect, useMemo, useState } from "react";
import { API, getSessions, approve, cancelSession, startTask, get, type SessionRow } from "@/lib/api";
import { Timeline } from "@/components/Timeline";

const vendorPill: Record<string, string> = {
  claude: "bg-blue/10 text-blue", openai: "bg-green/10 text-green", gemini: "bg-amber/10 text-amber",
};

export function SessionGrid() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [cursor, setCursor] = useState(0);

  useEffect(() => { getSessions().then(setSessions); }, []);

  // Live updates: patch the session's props from each event as it arrives.
  useEffect(() => {
    const es = new EventSource(`${API}/events?since=${cursor}`);
    const onAny = (ev: MessageEvent) => {
      if (ev.lastEventId) setCursor(Number(ev.lastEventId));
      const e = JSON.parse(ev.data);
      setSessions((prev) => {
        const i = prev.findIndex((s) => s.id === e.sessionId);
        const base: SessionRow = i >= 0 ? prev[i] : { id: e.sessionId, title: "New session", created_at: e.ts, updated_at: e.ts, props: {} };
        const props = { ...base.props };
        if (e.type === "started") Object.assign(props, { state: "running", vendor: e.vendor, runnerId: e.runnerId, startedAt: e.ts });
        if (e.type === "cost") Object.assign(props, { spendGbp: e.cumulativeGbp, tokensIn: e.tokensIn, tokensOut: e.tokensOut });
        if (e.type === "approval_request") Object.assign(props, { state: "parked", parkedCallId: e.callId, parkedGap: e.grantGap });
        if (e.type === "done") Object.assign(props, { state: "done", outcome: e.outcome });
        if (e.type === "error") Object.assign(props, { state: "error", lastEvent: e.message });
        if (e.type === "tool_call") props.lastEvent = `tool_call  ${e.tool}  ${e.policyDecision}`;
        if (e.type === "tool_result") props.lastEvent = `tool_result  ${e.summary.slice(0, 60)}`;
        if (e.type === "message" && e.role === "assistant") props.lastEvent = `message  ${e.text.slice(0, 60)}`;
        const next = { ...base, props, updated_at: e.ts };
        return i >= 0 ? prev.map((s, j) => (j === i ? next : s)) : [next, ...prev];
      });
    };
    for (const t of ["started", "message", "tool_call", "tool_result", "approval_request", "artifact", "cost", "done", "error"]) es.addEventListener(t, onAny as EventListener);
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => sessions.filter((s) => filter === "all" || s.props.vendor === filter || s.props.state === filter), [sessions, filter]);
  const count = (state: string) => sessions.filter((s) => s.props.state === state).length;
  const spend = sessions.reduce((a, s) => a + (s.props.spendGbp ?? 0), 0);

  async function newSession() {
    const prompt = window.prompt("Prompt for a Claude session in a scratch worktree:");
    if (!prompt) return;
    await startTask({ title: prompt.slice(0, 60), workflowId: crypto.randomUUID(), steps: [{ name: "do", prompt, maxCostGbp: 2 }] });
  }

  return (
    <>
      <header className="h-14 px-6 flex items-center gap-4 border-b border-black/10">
        <h1 className="text-lg font-bold leading-tight">Sessions</h1>
        <div className="ml-auto flex gap-2">
          <button onClick={newSession} className="h-9 px-3.5 rounded bg-red text-white text-sm font-semibold">New session</button>
        </div>
      </header>
      <div className="p-6 flex flex-col gap-5">
        <Timeline />
        <div className="grid grid-cols-5 gap-3">
          <Stat label="Running" value={count("running")} />
          <Stat label="Parked, needs you" value={count("parked")} accent />
          <Stat label="Queued" value={count("starting")} />
          <Stat label="Done" value={count("done")} />
          <Stat label="Spend" value={`£${spend.toFixed(2)}`} />
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          {["all", "claude", "openai", "gemini"].map((v) => <Pill key={v} active={filter === v} onClick={() => setFilter(v)}>{v === "all" ? "All vendors" : cap(v)}</Pill>)}
          <span className="w-px h-5 bg-black/15" />
          {["running", "parked", "done"].map((v) => <Pill key={v} active={filter === v} onClick={() => setFilter(v)}>{cap(v)}</Pill>)}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {visible.map((s) => <SessionCard key={s.id} s={s} onChange={() => getSessions().then(setSessions)} />)}
          {visible.length === 0 && <div className="col-span-2 text-ink-2 text-sm">No sessions yet. Start one with New session, or POST /tasks.</div>}
        </div>
      </div>
    </>
  );
}

function SessionCard({ s, onChange }: { s: SessionRow; onChange: () => void }) {
  const p = s.props; const parked = p.state === "parked";
  return (
    <article className={`bg-card rounded-lg p-4 shadow-sm flex flex-col gap-2.5 ${parked ? "border-l-[3px] border-red" : ""}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${vendorPill[p.vendor ?? ""] ?? "bg-black/5 text-ink-2"}`}>{cap(p.vendor ?? "pending")}</span>
        <State state={p.state} />
        <span className="ml-auto font-mono text-xs text-muted">{p.runnerId ?? ""}</span>
      </div>
      <div className="font-semibold leading-tight">{s.title || "Session"}</div>
      <div className="text-[13px] text-ink-2 flex gap-3">{p.projectId && <a href={`/projects/${p.projectId}`} className="font-semibold">project</a>}{p.mode && <span>{p.mode}</span>}{p.stepIndex != null && <span>step {Number(p.stepIndex) + 1}</span>}<a href={`/graph?node=${s.id}`} className="ml-auto text-red font-semibold">graph</a></div>
      <div className={`font-mono text-xs rounded px-2.5 py-2 ${parked ? "bg-red/10 text-red" : "bg-card-alt text-ink-2"}`}>{parked ? `approval_request  ${p.parkedGap}` : p.lastEvent ?? "waiting for first event"}</div>
      {parked && p.parkedCallId ? (
        <div className="flex gap-2">
          <Btn primary onClick={() => approve(s.id, p.parkedCallId!, "once").then(onChange)}>Approve once</Btn>
          <Btn onClick={() => approve(s.id, p.parkedCallId!, "deny").then(onChange)}>Deny</Btn>
        </div>
      ) : (
        <div className="flex gap-4 text-xs text-muted">
          <span>{((p.tokensIn ?? 0) + (p.tokensOut ?? 0)).toLocaleString()} tokens</span>
          <span>£{(p.spendGbp ?? 0).toFixed(2)}</span>
          {p.state === "running" && <button onClick={() => cancelSession(s.id).then(onChange)} className="ml-auto text-red font-semibold">Cancel</button>}
        </div>
      )}
    </article>
  );
}

function State({ state }: { state?: string }) {
  const map: Record<string, [string, string]> = { running: ["bg-green-2", "text-green"], parked: ["bg-red", "text-red"], done: ["bg-blue", "text-ink-2"], error: ["bg-red", "text-red"], starting: ["bg-muted", "text-muted"] };
  const [dot, text] = map[state ?? "starting"] ?? map.starting;
  return <span className={`flex items-center gap-1.5 text-[13px] ${text}`}><span className={`w-2 h-2 rounded-full ${dot}`} />{cap(state ?? "starting")}</span>;
}
function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return <div className={`bg-card rounded-lg px-4 py-3.5 shadow-sm ${accent ? "border-l-[3px] border-red" : ""}`}><div className="text-[13px] text-muted leading-tight">{label}</div><div className={`text-2xl font-bold leading-tight mt-1.5 ${accent ? "text-red" : ""}`}>{value}</div></div>;
}
function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`h-8 px-3 rounded-full text-[13px] ${active ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`}>{children}</button>;
}
function Btn({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`h-8 px-3 rounded text-[13px] ${primary ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`}>{children}</button>;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
