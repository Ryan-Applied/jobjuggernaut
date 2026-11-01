/**
 * Claude adapter over the Claude Agent SDK.
 *
 * The SDK's `query()` yields a stream of messages; its PreToolUse hook is the
 * interceptor seam. The hook calls ctx.checkPolicy; on "park" it emits an
 * approval_request and blocks until ctx.waitForApproval resolves.
 *
 * NOTE: the SDK surface moves; this file pins the shape we depend on behind
 * `sdk.ts` so a breaking change is one file. Exact import names should be
 * verified against the installed version before first run.
 */
import { eventFactory, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";
import { runQuery, type SdkMessage } from "./sdk.js";

interface Live {
  spec: SessionSpec;
  ctx: RunnerContext;
  queue: SessionEvent[];
  waiters: Array<() => void>;
  ended: boolean;
  abort: AbortController;
  emit: ReturnType<typeof eventFactory>;
  cumulativeGbp: number;
}

// Approximate list prices in GBP per 1k tokens; refined per model later.
const COST = { inputPer1k: 0.0024, outputPer1k: 0.012 };

export class ClaudeRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  constructor(id = "claude") { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return {
      runnerId: this.id, vendor: "claude",
      tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "mcp"],
      maxContextTokens: 200_000, supportsResume: true, supportsSubagents: true,
      costModel: { ...COST, currency: "GBP" },
    };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { spec, ctx, queue: [], waiters: [], ended: false, abort: new AbortController(), emit: eventFactory(spec.sessionId), cumulativeGbp: 0 };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.id, vendor: "claude", vendorSessionRef: spec.sessionId, workdir: spec.workdir }));

    void (async () => {
      try {
        for await (const m of runQuery({
          prompt: spec.prompt, systemPrompt: spec.systemPrompt, cwd: spec.workdir, signal: l.abort.signal,
          onToolUse: async (tool, args, callId) => {
            const res = await ctx.checkPolicy({ sessionId: spec.sessionId, tool, args, resource: {} });
            push(l.emit({ type: "tool_call", callId, tool, args, policyDecision: res.decision, grantId: res.grantId }));
            if (res.decision === "allow") return true;
            if (res.decision === "deny") return false;
            push(l.emit({ type: "approval_request", callId, tool, args, grantGap: res.gap ?? res.reason }));
            return ctx.waitForApproval(spec.sessionId, callId);
          },
        })) push(this.translate(l, m));
        push(l.emit({ type: "done", outcome: "complete", summary: "Claude session finished" }));
      } catch (err) {
        if (l.abort.signal.aborted) push(l.emit({ type: "done", outcome: "cancelled", summary: "cancelled" }));
        else push(l.emit({ type: "error", code: "runner_failed", message: String(err), retryable: false }));
      } finally { l.ended = true; l.waiters.splice(0).forEach((w) => w()); }
    })();

    return { sessionId: spec.sessionId, vendorSessionRef: spec.sessionId };
  }

  private translate(l: Live, m: SdkMessage): SessionEvent {
    switch (m.kind) {
      case "assistant": {
        const costGbp = (m.tokensIn / 1000) * COST.inputPer1k + (m.tokensOut / 1000) * COST.outputPer1k;
        l.cumulativeGbp += costGbp;
        return l.emit({ type: "message", role: "assistant", text: m.text, tokensIn: m.tokensIn, tokensOut: m.tokensOut, raw: m.raw });
      }
      case "tool_result": return l.emit({ type: "tool_result", callId: m.callId, ok: m.ok, summary: m.summary, bytes: m.bytes, raw: m.raw });
      case "cost": return l.emit({ type: "cost", tokensIn: m.tokensIn, tokensOut: m.tokensOut, costGbp: m.costGbp, cumulativeGbp: l.cumulativeGbp });
      default: return l.emit({ type: "message", role: "system", text: JSON.stringify(m), raw: m });
    }
  }

  async *stream(h: SessionHandle): AsyncIterable<SessionEvent> {
    const l = this.live.get(h.sessionId);
    if (!l) throw new Error(`unknown session ${h.sessionId}`);
    let i = 0;
    while (true) {
      while (i < l.queue.length) yield l.queue[i++];
      if (l.ended) return;
      await new Promise<void>((r) => l.waiters.push(r));
    }
  }

  async send(h: SessionHandle, input: SessionInput) {
    // Phase 1 sessions are single-prompt; multi-turn via SDK resume lands with Phase 2.
    throw new Error(`send not supported yet (${h.sessionId}): ${input.text.slice(0, 40)}`);
  }

  async cancel(h: SessionHandle) {
    this.live.get(h.sessionId)?.abort.abort();
  }
}
