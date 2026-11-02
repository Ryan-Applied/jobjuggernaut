"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Header, Btn, Pill, H2 } from "@/components/ui";

export function Chores() {
  const [rows, setRows] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const load = () => Promise.all([get<any>("/chores"), get<any>("/projects")]).then(([c, p]) => { setRows(c.chores); setProjects(p.projects); });
  useEffect(() => { load(); }, []);
  async function add() {
    const pick = window.prompt(`Project number:\n${projects.map((p, i) => `${i + 1}. ${p.title}`).join("\n")}`); const p = projects[Number(pick) - 1]; if (!p) return;
    const cron = window.prompt("Cron (5 fields, local time). e.g. 30 7 * * 1-5", "30 7 * * 1-5"); if (!cron) return;
    const mode = (window.prompt("Mode: auto | assist | manual", "auto") ?? "auto") as any;
    await post("/chores", { projectId: p.id, cron, mode }); load();
  }
  const act = (id: string, a: string) => post(`/chores/${id}/${a}`).then(load);
  return (
    <>
      <Header title="Chores" sub="Temporal schedules. Each fire builds a fresh task and ledger from the project's current template."><Btn primary onClick={add}>New chore</Btn></Header>
      <div className="p-6 grid grid-cols-2 gap-4">
        {rows.map((c) => <Card key={c.id} accent={c.props.paused ? undefined : "green"}><div className="flex items-center gap-2"><span className="font-bold">{c.title}</span><Pill tone={c.props.paused ? "grey" : "green"}>{c.props.paused ? "paused" : "active"}</Pill><Pill>{c.props.mode}</Pill></div>
          <div className="font-mono text-[13px]">{c.props.cron} <span className="text-muted">{c.props.tz}</span></div>
          <div className="text-[13px] text-ink-2">{c.project ?? c.workflow}. Next {c.next ? new Date(c.next).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "unknown"}{c.last ? `, last ${new Date(c.last).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</div>
          <div className="flex gap-1.5"><Btn onClick={() => act(c.id, "trigger")}>Run now</Btn><Btn onClick={() => act(c.id, c.props.paused ? "unpause" : "pause")}>{c.props.paused ? "Resume" : "Pause"}</Btn><Btn onClick={() => fetch(`${process.env.NEXT_PUBLIC_API_URL}/chores/${c.id}`, { method: "DELETE" }).then(load)}>Delete</Btn></div></Card>)}
        {rows.length === 0 && <div className="col-span-2 text-[13px] text-ink-2">No chores. The system schedules (overnight batch 22:00, nightly learn 03:00) run regardless.</div>}
      </div>
    </>
  );
}
