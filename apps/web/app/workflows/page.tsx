"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Header, Btn, H2 } from "@/components/ui";

export default function Page() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => get<{ workflows: any[] }>("/workflows").then((r) => setRows(r.workflows));
  useEffect(() => { load(); }, []);
  async function create() {
    const title = window.prompt("Workflow title"); if (!title) return;
    const prompt = window.prompt("Step 1 prompt"); if (!prompt) return;
    await post("/workflows", { title, steps: [{ name: "step 1", prompt, intendedActions: [{ tool: "Bash", scope: {}, cap: { count: 20 } }] }] });
    load();
  }
  return (
    <>
      <Header title="Workflows" sub={`${rows.length} defined`}><Btn primary onClick={create}>New workflow</Btn></Header>
      <div className="p-6 grid grid-cols-2 gap-4">
        {rows.map((w) => (
          <Card key={w.id}><div className="flex items-center gap-2"><a href={`/workflows/${w.id}`} className="font-bold">{w.title}</a>{w.chores > 0 && <span className="text-xs text-green font-semibold">chore</span>}</div>
            <div className="text-[13px] text-ink-2">{(w.props.steps ?? []).length} steps, {w.runs} runs{w.proposals ? `, ${w.proposals} proposals waiting` : ""}</div>
            <div className="text-[13px] text-muted">{(w.props.steps ?? []).map((s: any) => s.name).join(" → ") || "No definition yet; runs were started ad hoc"}</div></Card>))}
        {rows.length === 0 && <div className="text-[13px] text-ink-2">No workflows. Create one, or run a task and it will appear here.</div>}
      </div>
    </>
  );
}
