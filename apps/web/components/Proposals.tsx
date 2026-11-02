"use client";
import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { Card, Header, Btn, Pill } from "@/components/ui";
export function Proposals() {
  const [rows, setRows] = useState<any[]>([]);
  const load = () => get<any>("/proposals").then((r) => setRows(r.proposals));
  useEffect(() => { load(); }, []);
  return (<>
    <Header title="Proposals" sub="From the nightly learn pass. Nothing changes a template or skill without your click." />
    <div className="p-6 grid grid-cols-2 gap-4">
      {rows.map((p) => <Card key={p.id} accent="red"><div className="flex items-center gap-2"><span className="font-bold">{p.title}</span><Pill>{p.props.kind}</Pill></div><div className="text-[13px] text-ink-2">{p.props.kind === "skill_edit" ? (p.props.lessons ?? []).join(" ") : `Evidence: ${p.props.evidence} of ${p.props.of} runs`}</div><div className="flex gap-1.5"><Btn primary onClick={() => post(`/proposals/${p.id}/accept`).then(load)}>Accept</Btn><Btn onClick={() => post(`/proposals/${p.id}/reject`).then(load)}>Reject</Btn><Btn href={`/workflows/${p.props.workflowId}`}>Workflow</Btn></div></Card>)}
      {rows.length === 0 && <div className="col-span-2 text-[13px] text-ink-2">Nothing proposed yet.</div>}
    </div></>);
}
