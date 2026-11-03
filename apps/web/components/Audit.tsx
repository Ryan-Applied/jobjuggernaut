"use client";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
import { Card, Header, Pill } from "@/components/ui";
export function Audit() {
  const [rows, setRows] = useState<any[]>([]);
  const [f, setF] = useState("all");
  useEffect(() => { get<any>("/audit?limit=300").then((r) => setRows(r.audit)); }, []);
  const v = rows.filter((r) => f === "all" || r.decision === f);
  const tone = (d: string) => (d === "allow" ? "green" : d === "deny" ? "red" : "amber") as any;
  return (<>
    <Header title="Audit log" sub="Every policy decision with the grant behind it. Append-only.">
      {["all", "allow", "park", "deny"].map((x) => <button key={x} onClick={() => setF(x)} className={`h-8 px-3 rounded-full text-[13px] ${f === x ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`}>{x}</button>)}
    </Header>
    <div className="p-6"><Card>
      <table className="w-full text-[13px]"><thead><tr className="text-left font-mono text-[10px] tracking-widest uppercase text-muted"><th className="py-1.5">When</th><th>Session</th><th>Tool</th><th>Decision</th><th>Grant</th><th>Decided by</th></tr></thead>
      <tbody>{v.map((r) => <tr key={r.id} className="border-t border-black/10"><td className="py-1.5 font-mono text-xs">{new Date(r.ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td><td><a href={`/graph?node=${r.session_id}`} className="font-semibold">{r.session_title ?? r.session_id?.slice(0, 8)}</a></td><td className="font-mono">{r.tool}</td><td><Pill tone={tone(r.decision)}>{r.decision}</Pill></td><td className="font-mono text-xs text-muted">{r.grant_id ? r.grant_id.slice(0, 8) : ""}</td><td className="text-ink-2">{r.decided_by}</td></tr>)}</tbody></table>
      {v.length === 0 && <div className="text-[13px] text-ink-2">Nothing yet.</div>}
    </Card></div></>);
}
