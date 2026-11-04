/**
 * Claude adapter over the Claude Agent SDK.
 *  - PreToolUse hook is the interceptor (every tool, every mode).
 *  - Interactive sessions keep the SDK query open and feed follow-ups through `send` (B1).
 *  - Partial text deltas become `message{partial:true}` events, throttled (B8).
 *  - Artifacts are derived from tool calls and results (B2).
 *  - Sub-agent activity is tagged with subagentId (C4).
 */
import { eventFactory, artifactsFor, costGbp, USD_TO_GBP, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";
import { runQuery } from "./sdk.js";

const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";

class Inbox implements AsyncIterable<string> {
  private q: string[] = []; private waiters: Array<() => void> = []; private closed = false;
  push(t: string) { this.q.push(t); this.waiters.splice(0).forEach((w) => w()); }
  close() { this.closed = true; this.waiters.splice(0).forEach((w) => w()); }
  async *[Symbol.asyncIterator]() { while (true) { while (this.q.length) yield this.q.shift()!; if (this.closed) return; await new Promise<void>((r) => this.waiters.push(r)); } }
}

interface Live {
  spec: SessionSpec; queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; abort: AbortController;
  emit: ReturnType<typeof eventFactory>; cumulativeGbp: number; inbox?: Inbox; idle?: NodeJS.Timeout;
  pendingCalls: Map<string, { tool: string; args: Record<string, unknown> }>; delta: string; deltaAt: number;
}

export class ClaudeRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  constructor(id = "claude", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "claude", tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "mcp", "subagents"], maxContextTokens: 200_000, supportsResume: true, supportsSubagents: true, costModel: { inputPer1k: costGbp(MODEL, 1000, 0), outputPer1k: costGbp(MODEL, 0, 1000), currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { spec, ctx: undefined as any, queue: [], waiters: [], ended: false, abort: new AbortController(), emit: eventFactory(spec.sessionId), cumulativeGbp: 0, pendingCalls: new Map(), delta: "", deltaAt: 0 } as any;
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "claude", vendorSessionRef: spec.sessionId, workdir: spec.workdir }));
    if (spec.interactive) l.inbox = new Inbox();
    const armIdle = () => { if (!l.inbox) return; clearTimeout(l.idle); l.idle = setTimeout(() => { push(l.emit({ type: "message", role: "system", text: `idle for ${spec.idleMinutes ?? 10} min, closing` })); l.inbox?.close(); }, (spec.idleMinutes ?? 10) * 60_000); };

    void (async () => {
      try {
        armIdle();
        for await (const m of runQuery({
          prompt: spec.prompt, systemPrompt: spec.systemPrompt, cwd: spec.workdir, signal: l.abort.signal, followUps: l.inbox, partials: true,
          onToolUse: async (tool, args, callId, subagentId) => {
            const res = await ctx.checkPolicy({ sessionId: spec.sessionId, tool, args, resource: {} });
            l.pendingCalls.set(callId, { tool, args });
            push(l.emit({ type: "tool_call", callId, tool, args, policyDecision: res.decision, grantId: res.grantId, subagentId }));
            if (res.decision === "allow") return true;
            if (res.decision === "deny") return false;
            push(l.emit({ type: "approval_request", callId, tool, args, grantGap: res.gap ?? res.reason }));
            return ctx.waitForApproval(spec.sessionId, callId);
          },
        })) {
          armIdle();
          switch (m.kind) {
            case "delta": {
              l.delta += m.text;
              if (Date.now() - l.deltaAt > 800) { push(l.emit({ type: "message", role: "assistant", text: l.delta.slice(-400), partial: true })); l.deltaAt = Date.now(); }
              break;
            }
            case "assistant": {
              l.delta = "";
              push(l.emit({ type: "message", role: "assistant", text: m.text, tokensIn: m.tokensIn, tokensOut: m.tokensOut, subagentId: m.subagentId, raw: m.raw }));
              break;
            }
            case "tool_result": {
              push(l.emit({ type: "tool_result", callId: m.callId, ok: m.ok, summary: m.summary, bytes: m.bytes, raw: m.raw }));
              const call = l.pendingCalls.get(m.callId); l.pendingCalls.delete(m.callId);
              if (call && m.ok) for (const a of artifactsFor(call.tool, call.args, String((m.raw as any)?.content ?? m.summary), spec.workdir)) push(l.emit({ type: "artifact", ...a }));
              break;
            }
            case "turn_done": {
              const gbp = m.costUsd ? m.costUsd * USD_TO_GBP : costGbp(MODEL, m.tokensIn, m.tokensOut);
              l.cumulativeGbp += gbp;
              push(l.emit({ type: "cost", tokensIn: m.tokensIn, tokensOut: m.tokensOut, costGbp: gbp, cumulativeGbp: l.cumulativeGbp, raw: m.raw }));
              break;
            }
            default: push(l.emit({ type: "message", role: "system", text: JSON.stringify(m.raw).slice(0, 500), raw: m.raw }));
          }
        }
        push(l.emit({ type: "done", outcome: "complete", summary: "Claude session finished" }));
      } catch (err) {
        if (l.abort.signal.aborted) push(l.emit({ type: "done", outcome: "cancelled", summary: "cancelled" }));
        else push(l.emit({ type: "error", code: "runner_failed", message: String(err), retryable: false }));
      } finally { clearTimeout(l.idle); l.ended = true; l.waiters.splice(0).forEach((w) => w()); }
    })();

    return { sessionId: spec.sessionId, vendorSessionRef: spec.sessionId };
  }

  async *stream(h: SessionHandle): AsyncIterable<SessionEvent> {
    const l = this.live.get(h.sessionId);
    if (!l) throw new Error(`unknown session ${h.sessionId}`);
    let i = 0;
    while (true) { while (i < l.queue.length) yield l.queue[i++]; if (l.ended) return; await new Promise<void>((r) => l.waiters.push(r)); }
  }

  async send(h: SessionHandle, input: SessionInput) {
    const l = this.live.get(h.sessionId);
    if (!l?.inbox) throw new Error(`session ${h.sessionId} is not interactive`);
    l.queue.push(l.emit({ type: "message", role: "user", text: input.text })); l.waiters.splice(0).forEach((w) => w());
    l.inbox.push(input.text);
    if (input.final) l.inbox.close();
  }

  async cancel(h: SessionHandle) { const l = this.live.get(h.sessionId); l?.inbox?.close(); l?.abort.abort(); }
}
