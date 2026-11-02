import type { SessionEvent } from "@jj/core";

export interface SessionSummary {
  prompt: string;
  workflowId?: string;
  taskId?: string;
  vendor?: string;
  runnerId?: string;
  outcome: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costGbp: number;
  connectors: Record<string, number>;      // connector -> call count
  tools: Record<string, number>;
  parked: Array<{ tool: string; gap: string; resolved: "approved" | "denied" | "unresolved" }>;
  denied: string[];
  artifacts: Array<{ kind: string; uri: string; title: string }>;
  text: string;                             // canonical text that gets embedded
}

/** Deterministic summary from the event log. This, not the transcript, is what we embed. */
export function summarise(events: SessionEvent[], props: Record<string, any>): SessionSummary {
  const s: SessionSummary = {
    prompt: String(props.prompt ?? props.title ?? ""), workflowId: props.workflowId, taskId: props.taskId, vendor: undefined, runnerId: undefined,
    outcome: "unknown", durationMs: 0, tokensIn: 0, tokensOut: 0, costGbp: 0, connectors: {}, tools: {}, parked: [], denied: [], artifacts: [], text: "",
  };
  const parkedById = new Map<string, number>();
  let first: number | undefined, last: number | undefined;
  for (const e of events) {
    const t = Date.parse(e.ts); first ??= t; last = t;
    switch (e.type) {
      case "started": s.vendor = e.vendor; s.runnerId = e.runnerId; break;
      case "tool_call": {
        s.tools[e.tool] = (s.tools[e.tool] ?? 0) + 1;
        const conn = e.tool.includes(".") ? e.tool.split(".")[0] : "local";
        s.connectors[conn] = (s.connectors[conn] ?? 0) + 1;
        if (e.policyDecision === "deny") s.denied.push(e.tool);
        break;
      }
      case "approval_request": parkedById.set(e.callId, s.parked.push({ tool: e.tool, gap: e.grantGap, resolved: "unresolved" }) - 1); break;
      case "tool_result": { const i = parkedById.get(e.callId); if (i !== undefined) s.parked[i].resolved = e.ok ? "approved" : "denied"; break; }
      case "cost": s.tokensIn = e.tokensIn; s.tokensOut = e.tokensOut; s.costGbp = e.cumulativeGbp; break;
      case "artifact": s.artifacts.push({ kind: e.kind, uri: e.uri, title: e.title }); break;
      case "done": s.outcome = e.outcome; break;
      case "error": s.outcome = "error"; break;
    }
  }
  s.durationMs = first !== undefined && last !== undefined ? last - first : 0;
  s.text = [
    `task: ${s.prompt}`,
    `vendor: ${s.vendor ?? "?"} outcome: ${s.outcome}`,
    `tools: ${Object.entries(s.tools).map(([k, v]) => `${k}x${v}`).join(" ")}`,
    `connectors: ${Object.keys(s.connectors).join(" ")}`,
    s.parked.length ? `parked: ${s.parked.map((p) => `${p.tool} ${p.resolved}`).join("; ")}` : "",
    s.artifacts.length ? `artifacts: ${s.artifacts.map((a) => a.kind).join(" ")}` : "",
  ].filter(Boolean).join("\n");
  return s;
}

/** Plain-language lessons derived without a model; a model pass can append to these. */
export function lessons(s: SessionSummary, neighbours: SessionSummary[]): string[] {
  const out: string[] = [];
  for (const p of s.parked) {
    if (p.resolved === "approved") out.push(`Needed approval for ${p.tool} (${p.gap}); it was approved. Candidate for the grant template.`);
    if (p.resolved === "denied") out.push(`Attempted ${p.tool} and was denied: ${p.gap}.`);
  }
  if (neighbours.length) {
    const avg = neighbours.reduce((a, n) => a + n.costGbp, 0) / neighbours.length;
    if (avg > 0 && s.costGbp > avg * 1.5) out.push(`Cost £${s.costGbp.toFixed(2)} is ${(s.costGbp / avg).toFixed(1)}x the average of similar sessions (£${avg.toFixed(2)}).`);
    const recurring = neighbours.flatMap((n) => n.parked.map((p) => p.tool)).concat(s.parked.map((p) => p.tool));
    const counts = recurring.reduce<Record<string, number>>((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
    for (const [tool, n] of Object.entries(counts)) if (n >= 2) out.push(`${tool} has parked in ${n} of the last ${neighbours.length + 1} similar runs.`);
  }
  if (s.outcome === "error") out.push("Session ended in error.");
  return [...new Set(out)];
}
