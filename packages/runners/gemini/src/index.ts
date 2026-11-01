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
import { createInterface } from "node:readline";
import { eventFactory, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

const READ_ONLY = new Set(["read_file", "list_directory", "glob", "grep", "search_file_content", "web_fetch", "google_web_search"]);
const COST = { inputPer1k: 0.001, outputPer1k: 0.008 };

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

    createInterface({ input: proc.stdout! }).on("line", async (line) => {
      let m: any; try { m = JSON.parse(line); } catch { return; }
      if (m.type === "assistant" || m.type === "message") {
        const text = m.content ?? m.text ?? "";
        push(l.emit({ type: "message", role: "assistant", text, raw: m }));
      } else if (m.type === "tool_call" || m.type === "tool_use") {
        const tool = m.name ?? m.tool ?? "unknown"; const args = m.args ?? m.input ?? {}; const callId = m.id ?? crypto.randomUUID();
        const res = READ_ONLY.has(tool)
          ? await ctx.checkPolicy({ sessionId: spec.sessionId, tool, args, resource: {} })
          : { decision: "deny" as const, reason: "gemini reviewer is read-only" };
        push(l.emit({ type: "tool_call", callId, tool, args, policyDecision: res.decision, grantId: (res as any).grantId }));
      } else if (m.type === "tool_result") {
        push(l.emit({ type: "tool_result", callId: m.id ?? "", ok: !m.error, summary: String(m.output ?? m.error ?? "").slice(0, 160), raw: m }));
      } else if (m.type === "usage" || m.usage) {
        const u = m.usage ?? m; tokensIn += u.input_tokens ?? u.promptTokens ?? 0; tokensOut += u.output_tokens ?? u.candidatesTokens ?? 0;
        const costGbp = (tokensIn / 1000) * COST.inputPer1k + (tokensOut / 1000) * COST.outputPer1k; cumulative = costGbp;
        push(l.emit({ type: "cost", tokensIn, tokensOut, costGbp, cumulativeGbp: cumulative }));
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
