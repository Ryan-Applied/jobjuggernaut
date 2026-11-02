import type { ReactNode } from "react";
export const cap = (s?: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
export const money = (n?: number) => `£${(n ?? 0).toFixed(2)}`;
export function Card({ children, accent, className = "" }: { children: ReactNode; accent?: "red" | "green"; className?: string }) {
  const b = accent === "red" ? "border-l-[3px] border-red" : accent === "green" ? "border-l-[3px] border-green" : "";
  return <div className={`bg-card rounded-lg p-4 shadow-sm flex flex-col gap-2.5 ${b} ${className}`}>{children}</div>;
}
export function Eyebrow({ children }: { children: ReactNode }) { return <div className="font-mono text-[10px] font-bold tracking-widest uppercase text-muted">{children}</div>; }
export function H2({ children }: { children: ReactNode }) { return <h2 className="m-0 text-[15px] font-bold leading-tight">{children}</h2>; }
export function Header({ title, children, sub }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return <header className="h-14 px-6 flex items-center gap-4 border-b border-black/10"><h1 className="text-lg font-bold leading-tight">{title}</h1>{sub && <span className="text-[13px] text-muted">{sub}</span>}<div className="ml-auto flex gap-2">{children}</div></header>;
}
export function Btn({ primary, onClick, children, href }: { primary?: boolean; onClick?: () => void; children: ReactNode; href?: string }) {
  const cls = `h-8 px-3 rounded text-[13px] inline-flex items-center ${primary ? "bg-red text-white font-semibold" : "bg-card border border-black/15"}`;
  return href ? <a href={href} className={cls}>{children}</a> : <button onClick={onClick} className={cls}>{children}</button>;
}
export function Pill({ children, tone = "grey" }: { children: ReactNode; tone?: "blue" | "green" | "amber" | "red" | "grey" }) {
  const t = { blue: "bg-blue/10 text-blue", green: "bg-green/10 text-green", amber: "bg-amber/10 text-amber", red: "bg-red/10 text-red", grey: "bg-black/5 text-ink-2" }[tone];
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${t}`}>{children}</span>;
}
export const vendorTone = (v?: string) => (v === "claude" ? "blue" : v === "openai" ? "green" : v === "gemini" ? "amber" : "grey") as "blue" | "green" | "amber" | "grey";
export function Stat({ label, value, accent }: { label: string; value: ReactNode; accent?: boolean }) {
  return <div className={`bg-card rounded-lg px-4 py-3.5 shadow-sm ${accent ? "border-l-[3px] border-red" : ""}`}><div className="text-[13px] text-muted leading-tight">{label}</div><div className={`text-2xl font-bold leading-tight mt-1.5 ${accent ? "text-red" : ""}`}>{value}</div></div>;
}
