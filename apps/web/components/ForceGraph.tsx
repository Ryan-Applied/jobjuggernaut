"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface GNode { id: string; type: string; title: string; weight?: number }
export interface GEdge { src: string; dst: string; type: string; weight?: number }

const COLOUR: Record<string, string> = { session: "#18181c", workflow: "#e9311a", skill: "#e9311a", connector: "#1f4381", runner: "#767676", approval: "#9a6700", artifact: "#188258", project: "#e9311a", proposal: "#9a6700", grant: "#555555", task: "#555555" };

/** D4: a small spring layout, no dependencies. Good to ~150 nodes. */
export function ForceGraph({ nodes, edges, centre, onPick, hidden }: { nodes: GNode[]; edges: GEdge[]; centre: string; onPick: (id: string) => void; hidden: Set<string> }) {
  const W = 760, H = 520;
  const ref = useRef<SVGSVGElement>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const visible = useMemo(() => ({ nodes: nodes.filter((n) => n.id === centre || !hidden.has(n.type)), edges: edges.filter((e) => !hidden.has(e.type)) }), [nodes, edges, hidden, centre]);
  useEffect(() => {
    const p: Record<string, { x: number; y: number; vx: number; vy: number }> = {};
    visible.nodes.forEach((n, i) => { const a = (i / Math.max(1, visible.nodes.length)) * Math.PI * 2; p[n.id] = n.id === centre ? { x: W / 2, y: H / 2, vx: 0, vy: 0 } : { x: W / 2 + Math.cos(a) * 180, y: H / 2 + Math.sin(a) * 180, vx: 0, vy: 0 }; });
    const ids = visible.nodes.map((n) => n.id);
    for (let it = 0; it < 240; it++) {
      for (const a of ids) for (const b of ids) { if (a >= b) continue; const dx = p[b].x - p[a].x, dy = p[b].y - p[a].y; const d2 = Math.max(60, dx * dx + dy * dy); const f = 2600 / d2; const ux = dx / Math.sqrt(d2), uy = dy / Math.sqrt(d2); p[a].vx -= f * ux; p[a].vy -= f * uy; p[b].vx += f * ux; p[b].vy += f * uy; }
      for (const e of visible.edges) { const a = p[e.src], b = p[e.dst]; if (!a || !b) continue; const dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) || 1; const target = e.type === "similar_to" ? 120 + (1 - (e.weight ?? 0.8)) * 200 : 140; const f = (d - target) * 0.015; a.vx += f * dx / d; a.vy += f * dy / d; b.vx -= f * dx / d; b.vy -= f * dy / d; }
      for (const id of ids) { const q = p[id]; if (id === centre) { q.vx = q.vy = 0; continue; } q.vx += (W / 2 - q.x) * 0.002; q.vy += (H / 2 - q.y) * 0.002; q.x += q.vx * 0.6; q.y += q.vy * 0.6; q.vx *= 0.6; q.vy *= 0.6; q.x = Math.max(24, Math.min(W - 24, q.x)); q.y = Math.max(16, Math.min(H - 16, q.y)); }
    }
    setPos(Object.fromEntries(ids.map((id) => [id, { x: p[id].x, y: p[id].y }])));
  }, [visible, centre]);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-[520px] bg-card-alt rounded-lg" role="img" aria-label="Neighbourhood graph">
      {visible.edges.map((e, i) => { const a = pos[e.src], b = pos[e.dst]; if (!a || !b) return null; const sim = e.type === "similar_to"; return <g key={i}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={sim ? "#767676" : e.type === "part_of" || e.type === "uses_skill" ? "#e9311a" : "#c8d5de"} strokeWidth={sim ? 1 + (e.weight ?? 0.8) * 2 : 1.25} strokeDasharray={sim ? "4 4" : undefined} opacity="0.8" /><text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} fontSize="9" fill="#767676" textAnchor="middle">{e.type}{sim && e.weight ? ` ${Number(e.weight).toFixed(2)}` : ""}</text></g>; })}
      {visible.nodes.map((n) => { const q = pos[n.id]; if (!q) return null; const c = COLOUR[n.type] ?? "#555555"; const isC = n.id === centre; return (
        <g key={n.id} transform={`translate(${q.x},${q.y})`} onClick={() => onPick(n.id)} style={{ cursor: "pointer" }}>
          <circle r={isC ? 14 : n.type === "session" ? 9 : 7} fill={isC ? "#18181c" : "#ffffff"} stroke={c} strokeWidth={isC ? 3 : 2} />
          <text y={isC ? 28 : 20} fontSize={isC ? 12 : 10} fontWeight={isC ? 700 : 500} textAnchor="middle" fill="#18181c">{n.title.length > 28 ? n.title.slice(0, 27) + "…" : n.title}</text>
          <text y={isC ? 40 : 31} fontSize="9" textAnchor="middle" fill="#767676">{n.type}</text>
        </g>); })}
    </svg>
  );
}
