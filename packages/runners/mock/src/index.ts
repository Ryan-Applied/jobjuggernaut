/**
 * Deterministic runner for tests and demos. No vendor, no network, no cost.
 * Script is driven by the prompt:
 *   "tool:<name>"  -> one tool call through the interceptor (parks if no grant)
 *   "slow:<ms>"    -> sleep that long between messages (for cancel / restart tests)
 *   "fail"         -> emit error
 * Anything else: two messages, then done.
 */
import { eventFactory, artifactsFor, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

interface Live { queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; cancelled: boolean; emit: ReturnType<typeof eventFactory>; inbox: string[]; inboxWaiters: Array<() => void>; closed: boolean }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  constructor(id = "mock", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "claude", tools: ["Bash", "Read"], maxContextTokens: 100_000, supportsResume: false, supportsSubagents: false, costModel: { inputPer1k: 0, outputPer1k: 0, currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { queue: [], waiters: [], ended: false, cancelled: false, emit: eventFactory(spec.sessionId), inbox: [], inboxWaiters: [], closed: !spec.interactive };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    const end = () => { l.ended = true; l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "claude", vendorSessionRef: `mock-${spec.sessionId}`, workdir: spec.workdir }));

    const runDirectives = async (text: string) => {
      const directives = text.split(/\s+/);
      for (const d of directives) {
        if (l.cancelled) break;
        if (d.startsWith("slow:")) await sleep(Number(d.slice(5)));
        else if (d === "fail") { push(l.emit({ type: "error", code: "mock_fail", message: "asked to fail", retryable: false })); l.closed = true; l.cancelled = true; (l as any).failed = true; return; }
        else if (d.startsWith("tool:")) {
          const tool = d.slice(5); const callId = `${spec.sessionId.slice(0, 8)}-call-${l.queue.length}`;
          const res = await ctx.checkPolicy({ sessionId: spec.sessionId, tool, args: { cmd: "ls" }, resource: {} });
          push(l.emit({ type: "tool_call", callId, tool, args: { cmd: "ls" }, policyDecision: res.decision, grantId: res.grantId }));
          let ok = res.decision === "allow";
          if (res.decision === "park") {
            push(l.emit({ type: "approval_request", callId, tool, args: { cmd: "ls" }, grantGap: res.gap ?? res.reason }));
            ok = await ctx.waitForApproval(spec.sessionId, callId);
          }
          push(l.emit({ type: "tool_result", callId, ok, summary: ok ? "total 0" : "blocked", bytes: 7 }));
          if (ok) for (const a of artifactsFor(tool, { cmd: "ls", path: d.includes("Write") ? "out.txt" : undefined }, tool === "Bash" ? "https://github.com/applied/atlas/pull/42" : "ok", spec.workdir)) push(l.emit({ type: "artifact", ...a }));
        }
      }
    };
    void (async () => {
      push(l.emit({ type: "message", role: "assistant", text: `mock: working on "${spec.prompt}"`, tokensIn: 10, tokensOut: 20 }));
      await runDirectives(spec.prompt);
      // interactive: keep taking follow-ups until closed (B1)
      while ((!l.closed || l.inbox.length > 0) && !l.cancelled) {
        if (!l.inbox.length) await new Promise<void>((r) => l.inboxWaiters.push(r));
        const next = l.inbox.shift(); if (next === undefined) continue;
        push(l.emit({ type: "message", role: "assistant", text: `mock: follow-up "${next}"`, tokensIn: 5, tokensOut: 5 }));
        await runDirectives(next);
      }
      if ((l as any).failed) { end(); return; }
      if (l.cancelled) { push(l.emit({ type: "done", outcome: "cancelled", summary: "cancelled" })); end(); return; }
      push(l.emit({ type: "message", role: "assistant", text: "mock: finished", tokensIn: 5, tokensOut: 10 }));
      push(l.emit({ type: "cost", tokensIn: 15, tokensOut: 30, costGbp: 0.001, cumulativeGbp: 0.001 }));
      push(l.emit({ type: "done", outcome: "complete", summary: "mock complete" }));
      end();
    })();
    return { sessionId: spec.sessionId, vendorSessionRef: `mock-${spec.sessionId}` };
  }

  async *stream(h: SessionHandle): AsyncIterable<SessionEvent> {
    const l = this.live.get(h.sessionId); if (!l) throw new Error("unknown session");
    let i = 0;
    while (true) { while (i < l.queue.length) yield l.queue[i++]; if (l.ended) return; await new Promise<void>((r) => l.waiters.push(r)); }
  }
  async send(h: SessionHandle, i: SessionInput) { const l = this.live.get(h.sessionId); if (!l || l.closed) throw new Error("not interactive"); l.inbox.push(i.text); if (i.final) l.closed = true; l.inboxWaiters.splice(0).forEach((w) => w()); }
  async cancel(h: SessionHandle) { const l = this.live.get(h.sessionId); if (l) { l.cancelled = true; l.closed = true; l.inboxWaiters.splice(0).forEach((w) => w()); } }
}
