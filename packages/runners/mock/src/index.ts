/**
 * Deterministic runner for tests and demos. No vendor, no network, no cost.
 * Script is driven by the prompt:
 *   "tool:<name>"  -> one tool call through the interceptor (parks if no grant)
 *   "slow:<ms>"    -> sleep that long between messages (for cancel / restart tests)
 *   "fail"         -> emit error
 * Anything else: two messages, then done.
 */
import { eventFactory, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

interface Live { queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; cancelled: boolean; emit: ReturnType<typeof eventFactory> }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  constructor(id = "mock", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "claude", tools: ["Bash", "Read"], maxContextTokens: 100_000, supportsResume: false, supportsSubagents: false, costModel: { inputPer1k: 0, outputPer1k: 0, currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { queue: [], waiters: [], ended: false, cancelled: false, emit: eventFactory(spec.sessionId) };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    const end = () => { l.ended = true; l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "claude", vendorSessionRef: `mock-${spec.sessionId}`, workdir: spec.workdir }));

    void (async () => {
      const directives = spec.prompt.split(/\s+/);
      push(l.emit({ type: "message", role: "assistant", text: `mock: working on "${spec.prompt}"`, tokensIn: 10, tokensOut: 20 }));
      for (const d of directives) {
        if (l.cancelled) break;
        if (d.startsWith("slow:")) await sleep(Number(d.slice(5)));
        else if (d === "fail") { push(l.emit({ type: "error", code: "mock_fail", message: "asked to fail", retryable: false })); end(); return; }
        else if (d.startsWith("tool:")) {
          const tool = d.slice(5); const callId = `call-${l.queue.length}`;
          const res = await ctx.checkPolicy({ sessionId: spec.sessionId, tool, args: { cmd: "ls" }, resource: {} });
          push(l.emit({ type: "tool_call", callId, tool, args: { cmd: "ls" }, policyDecision: res.decision, grantId: res.grantId }));
          let ok = res.decision === "allow";
          if (res.decision === "park") {
            push(l.emit({ type: "approval_request", callId, tool, args: { cmd: "ls" }, grantGap: res.gap ?? res.reason }));
            ok = await ctx.waitForApproval(spec.sessionId, callId);
          }
          push(l.emit({ type: "tool_result", callId, ok, summary: ok ? "total 0" : "blocked", bytes: 7 }));
        }
      }
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
  async send(_h: SessionHandle, _i: SessionInput) { /* single-turn */ }
  async cancel(h: SessionHandle) { const l = this.live.get(h.sessionId); if (l) l.cancelled = true; }
}
