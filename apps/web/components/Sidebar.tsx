"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { get } from "@/lib/api";
const items = [
  ["Today", "/today"], ["Sessions", "/"], ["Graph", "/graph"], ["Approvals", "/approvals"],
  ["Chores", "/chores"], ["Workflows", "/workflows"], ["Ingest", "/drafts"], ["Proposals", "/proposals"], ["Audit log", "/audit"],
];
export function Sidebar() {
  const path = usePathname();
  const [runners, setRunners] = useState<any[]>([]);
  useEffect(() => { const f = () => get<any>("/runners").then((r) => setRunners(r.runners)).catch(() => {}); f(); const t = setInterval(f, 30000); return () => clearInterval(t); }, []);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <nav aria-label="Primary" className="w-60 shrink-0 bg-nav text-white p-4 flex flex-col gap-6">
      <div className="flex items-center gap-2.5 px-2 py-1">
        <div className="w-7 h-7 bg-red rounded" />
        <div className="font-bold leading-tight">Control plane</div>
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map(([label, href]) => (
          <a key={href} href={href} className={`px-3 py-2.5 rounded text-sm leading-tight ${active(href) ? "bg-white/10 text-white font-semibold" : "text-nav-text"}`}>{label}</a>
        ))}
      </div>
      <div className="mt-auto p-3 bg-white/5 rounded-lg text-[13px] flex flex-col gap-2">
        <div className="font-mono text-[10px] font-bold tracking-widest uppercase text-muted">Runners</div>
        {runners.map((r) => <div key={r.id} className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full ${r.live ? "bg-green-2" : "bg-red"}`} />{r.title}: {r.live ? `${r.props.live ?? 0} live, ${(r.props.vendors ?? []).join("/")}` : "offline"}</div>)}
        {runners.length === 0 && <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-muted" />No runner seen yet</div>}
      </div>
    </nav>
  );
}
