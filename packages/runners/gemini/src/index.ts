/**
 * Gemini adapter over the Gemini CLI, used first as the read-only reviewer.
 *
 * Runs `gemini -p <prompt> --output-format stream-json` in the worktree and
 * translates its JSON lines. Tool calls are intercepted by running the CLI in
 * sandbox mode with tools disabled except read-only ones; any write tool it
 * requests is reported as a denied tool_call. Full interception via the CLI's
 * hook mechanism lands when the Phase 2 reviewer needs to write.
 */
import { spawn } from "node:child_process";
import { parseLine } from "./parse.js";
import { createInterface } from "node:readline";
import { eventFactory, artifactsFor, costGbp, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

const READ_ONLY = new Set(["read_file", "list_directory", "glob", "grep", "search_file_content", "web_fetch", "google_web_search"]);
const MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-pro";
const COST = { inputPer1k: costGbp(MODEL, 1000, 0), outputPer1k: costGbp(MODEL, 0, 1000) };
export { parseLine } from "./parse.js";

interface Live { queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; proc?: ReturnType<typeof spawn>; emit: ReturnType<typeof eventFactory> }

export class GeminiRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  constructor(id = "gemini", private bin = process.env.GEMINI_BIN ?? "gemini", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "gemini", tools: [...READ_ONLY], maxContextTokens: 1_000_000, supportsResume: false, supportsSubagents: false, costModel: { ...COST, currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { queue: [], waiters: [], ended: false, emit: eventFactory(spec.sessionId) };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "gemini", vendorSessionRef: spec.sessionId, workdir: spec.workdir }));

    const prompt = spec.systemPrompt ? `${spec.systemPrompt}\n\n${spec.prompt}` : spec.prompt;
    const proc = spawn(this.bin, ["-p", prompt, "--output-format", "stream-json", "--sandbox"], { cwd: spec.workdir, env: { ...process.env } });
    l.proc = proc;
    let tokensIn = 0, tokensOut = 0, cumulative = 0;

    const pending = new Map<string, { tool: string; args: Record<string, unknown> }>();
    createInterface({ input: proc.stdout! }).on("line", async (line) => {
      for (const p of parseLine(line)) {
        if (p.kind === "text") push(l.emit({ type: "message", role: "assistant", text: p.text, raw: p.raw }));
        else if (p.kind === "tool_call") {
          const res = READ_ONLY.has(p.tool) ? await ctx.checkPolicy({ sessionId: spec.sessionId, tool: p.tool, args: p.args, resource: {} }) : { decision: "deny" as const, reason: "gemini reviewer is read-only" };
          pending.set(p.callId, { tool: p.tool, args: p.args });
          push(l.emit({ type: "tool_call", callId: p.callId, tool: p.tool, args: p.args, policyDecision: res.decision, grantId: (res as any).grantId }));
        } else if (p.kind === "tool_result") {
          push(l.emit({ type: "tool_result", callId: p.callId, ok: p.ok, summary: p.text.slice(0, 160), raw: p.raw }));
          const c = pending.get(p.callId); pending.delete(p.callId);
          if (c && p.ok) for (const a of artifactsFor(c.tool, c.args, p.text, spec.workdir)) push(l.emit({ type: "artifact", ...a }));
        } else if (p.kind === "usage") {
          tokensIn += p.tokensIn; tokensOut += p.tokensOut; cumulative = (tokensIn / 1000) * COST.inputPer1k + (tokensOut / 1000) * COST.outputPer1k;
          push(l.emit({ type: "cost", tokensIn, tokensOut, costGbp: cumulative, cumulativeGbp: cumulative }));
        }
      }
    });
    proc.stderr?.on("data", (d) => push(l.emit({ type: "message", role: "system", text: String(d).trim(), raw: { stderr: true } })));
    proc.on("close", (code, sig) => {
      if (sig === "SIGTERM") push(l.emit({ type: "done", outcome: "cancelled", summary: "cancelled" }));
      else if (code === 0) push(l.emit({ type: "done", outcome: "complete", summary: "Gemini review finished" }));
      else push(l.emit({ type: "error", code: `exit_${code}`, message: "gemini exited non-zero", retryable: false }));
      l.ended = true; l.waiters.splice(0).forEach((w) => w());
    });
    return { sessionId: spec.sessionId, vendorSessionRef: String(proc.pid) };
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
  async send(h: SessionHandle, input: SessionInput) { throw new Error(`gemini runner is single-turn (${h.sessionId}): ${input.text.slice(0, 40)}`); }
  async cancel(h: SessionHandle) { this.live.get(h.sessionId)?.proc?.kill("SIGTERM"); }
}
