"use client";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { Card, H2 } from "@/components/ui";

/** 06:00 to 24:00 today, one lane per runner, bars per session, shaded overnight window. */
export function Timeline() {
  const [d, setD] = useState<{ sessions: any[]; queued: any[] } | null>(null);
  useEffect(() => { const f = () => get<any>("/timeline?hours=18").then(setD); f(); const t = setInterval(f, 15000); return () => clearInterval(t); }, []);
  if (!d) return null;
  const start = new Date(); start.setHours(6, 0, 0, 0); const span = 18 * 3600_000;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start.getTime()) / span) * 100));
  const now = pct(Date.now());
  const lanes = new Map<string, any[]>();
  for (const s of d.sessions) { const k = s.props.runnerId ?? "runner"; (lanes.get(k) ?? lanes.set(k, []).get(k))!.push(s); }
  if (d.queued.length) lanes.set("tonight", d.queued.map((q) => ({ id: q.id, title: q.title, props: { startedAt: q.props.scheduledFor, state: "queued" }, created_at: q.props.scheduledFor })));
  const colour = (st?: string) => st === "parked" ? "bg-red text-white" : st === "running" || st === "starting" ? "bg-green-2 text-white" : st === "queued" ? "bg-card border border-dashed border-black/30 text-ink-2" : "bg-nav-text text-ink";
  return (
    <Card>
      <div className="flex items-center gap-3"><H2>Today, 06:00 to 24:00</H2><span className="text-[13px] text-muted">Now {new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Shaded: overnight window.</span><a href="/today" className="ml-auto text-[13px] font-semibold text-red">Morning brief</a></div>
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2 items-center text-xs">
        <div /><div className="relative h-4 text-muted font-mono">{[6, 9, 12, 15, 18, 21].map((h) => <span key={h} className="absolute" style={{ left: `${((h - 6) / 18) * 100}%` }}>{String(h).padStart(2, "0")}:00</span>)}<span className="absolute right-0">24:00</span></div>
        {[...lanes.entries()].map(([lane, items]) => (<div key={lane} className="contents">
          <div className="text-ink-2 leading-tight">{lane}</div>
          <div className="relative h-7 bg-card-alt rounded overflow-hidden">
            <div className="absolute top-0 h-7 bg-nav/5" style={{ left: `${(16 / 18) * 100}%`, width: `${(2 / 18) * 100}%` }} />
            {items.map((s) => { const a = Date.parse(s.props.startedAt ?? s.created_at); const b = s.props.endedAt ? Date.parse(s.props.endedAt) : (s.props.state === "queued" ? a + 2 * 3600_000 : Date.now()); const l = pct(a), w = Math.max(0.6, pct(b) - l); return (
              <a key={s.id} href={`/graph?node=${s.id}`} title={s.title} className={`absolute top-1 h-5 rounded px-2 leading-5 whitespace-nowrap overflow-hidden text-ellipsis ${colour(s.props.state)}`} style={{ left: `${l}%`, width: `${w}%` }}>{w > 6 ? s.title : ""}</a>); })}
            <div className="absolute top-0 w-0.5 h-7 bg-ink" style={{ left: `${now}%` }} />
          </div></div>))}
        {lanes.size === 0 && <div className="col-span-2 text-ink-2">No sessions today yet.</div>}
      </div>
    </Card>
  );
}
