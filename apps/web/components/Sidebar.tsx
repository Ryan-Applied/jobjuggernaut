const items = [
  ["Today", "/today"], ["Sessions", "/"], ["Graph", "/graph"], ["Approvals", "/approvals"],
  ["Chores", "/chores"], ["Workflows", "/workflows"], ["Skills", "/skills"], ["Agents", "/agents"], ["Connectors", "/connectors"], ["Audit log", "/audit"],
];
export function Sidebar() {
  return (
    <nav aria-label="Primary" className="w-60 shrink-0 bg-nav text-white p-4 flex flex-col gap-6">
      <div className="flex items-center gap-2.5 px-2 py-1">
        <div className="w-7 h-7 bg-red rounded" />
        <div className="font-bold leading-tight">Control plane</div>
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map(([label, href]) => (
          <a key={href} href={href} className={`px-3 py-2.5 rounded text-sm leading-tight ${href === "/" ? "bg-white/10 text-white font-semibold" : "text-nav-text"}`}>{label}</a>
        ))}
      </div>
      <div className="mt-auto p-3 bg-white/5 rounded-lg text-[13px] flex flex-col gap-2">
        <div className="font-mono text-[10px] font-bold tracking-widest uppercase text-muted">Runners</div>
        <RunnerLine label="Laptop" />
      </div>
    </nav>
  );
}
function RunnerLine({ label }: { label: string }) {
  return <div className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-green-2" />{label}: connected</div>;
}
