/**
 * OpenAI adapter. Uses the Responses API with function tools in a manual loop,
 * which gives us the interceptor seam for free: every function call the model
 * emits comes back to us before anything runs. Tools offered: a small
 * read/write/bash set executed in the worktree, each gated by ctx.checkPolicy.
 *
 * Model and prices are configurable; defaults are conservative.
 */
import OpenAI from "openai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { eventFactory, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

const run = promisify(execFile);
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const COST = { inputPer1k: Number(process.env.OPENAI_IN_GBP_1K ?? 0.00032), outputPer1k: Number(process.env.OPENAI_OUT_GBP_1K ?? 0.00128) };

const TOOLS: OpenAI.Responses.Tool[] = [
  { type: "function", name: "Bash", description: "Run a shell command in the working directory.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false }, strict: true },
  { type: "function", name: "Read", description: "Read a file relative to the working directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
  { type: "function", name: "Write", description: "Write a file relative to the working directory.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, strict: true },
];

interface Live { queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; abort: AbortController; emit: ReturnType<typeof eventFactory> }

export class OpenAIRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  private client = new OpenAI();
  constructor(id = "openai", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "openai", tools: TOOLS.map((t: any) => t.name), maxContextTokens: 1_000_000, supportsResume: false, supportsSubagents: false, costModel: { ...COST, currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { queue: [], waiters: [], ended: false, abort: new AbortController(), emit: eventFactory(spec.sessionId) };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    const end = () => { l.ended = true; l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "openai", vendorSessionRef: `openai-${spec.sessionId}`, workdir: spec.workdir }));

    void (async () => {
      let tokensIn = 0, tokensOut = 0, cumulative = 0;
      let input: OpenAI.Responses.ResponseInput = [{ role: "user", content: spec.prompt }];
      try {
        for (let turn = 0; turn < 24; turn++) {
          if (l.abort.signal.aborted) break;
          const res = await this.client.responses.create({ model: MODEL, instructions: spec.systemPrompt ?? "You are a careful engineering agent working in a sandboxed directory. Use tools when needed, then summarise.", input, tools: TOOLS }, { signal: l.abort.signal });
          tokensIn += res.usage?.input_tokens ?? 0; tokensOut += res.usage?.output_tokens ?? 0;
          cumulative = (tokensIn / 1000) * COST.inputPer1k + (tokensOut / 1000) * COST.outputPer1k;
          push(l.emit({ type: "cost", tokensIn, tokensOut, costGbp: cumulative, cumulativeGbp: cumulative, raw: res.usage }));

          const text = res.output_text;
          if (text) push(l.emit({ type: "message", role: "assistant", text, tokensIn: res.usage?.input_tokens ?? 0, tokensOut: res.usage?.output_tokens ?? 0 }));

          const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
          if (!calls.length) break;

          input = [...input, ...res.output];
          for (const c of calls) {
            const args = safeJson(c.arguments);
            const decision = await ctx.checkPolicy({ sessionId: spec.sessionId, tool: c.name, args, resource: {} });
            push(l.emit({ type: "tool_call", callId: c.call_id, tool: c.name, args, policyDecision: decision.decision, grantId: decision.grantId }));
            let ok = decision.decision === "allow";
            if (decision.decision === "park") {
              push(l.emit({ type: "approval_request", callId: c.call_id, tool: c.name, args, grantGap: decision.gap ?? decision.reason }));
              ok = await ctx.waitForApproval(spec.sessionId, c.call_id);
            }
            const output = ok ? await this.exec(spec.workdir, c.name, args) : "Blocked by policy: no grant covers this call.";
            push(l.emit({ type: "tool_result", callId: c.call_id, ok, summary: output.slice(0, 160), bytes: output.length }));
            input.push({ type: "function_call_output", call_id: c.call_id, output });
          }
        }
        push(l.emit({ type: "done", outcome: l.abort.signal.aborted ? "cancelled" : "complete", summary: "OpenAI session finished" }));
      } catch (err) {
        if (l.abort.signal.aborted) push(l.emit({ type: "done", outcome: "cancelled", summary: "cancelled" }));
        else push(l.emit({ type: "error", code: "runner_failed", message: String(err), retryable: false }));
      } finally { end(); }
    })();
    return { sessionId: spec.sessionId, vendorSessionRef: `openai-${spec.sessionId}` };
  }

  private async exec(cwd: string, tool: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (tool === "Bash") { const { stdout, stderr } = await run("sh", ["-c", String(args.cmd)], { cwd, timeout: 60_000, maxBuffer: 1 << 20 }); return (stdout + stderr).trim() || "(no output)"; }
      if (tool === "Read") return await readFile(resolve(cwd, String(args.path)), "utf8");
      if (tool === "Write") { const p = resolve(cwd, String(args.path)); await mkdir(dirname(p), { recursive: true }); await writeFile(p, String(args.content)); return `wrote ${args.path}`; }
      return `unknown tool ${tool}`;
    } catch (e) { return `error: ${String(e).slice(0, 500)}`; }
  }

  async *stream(h: SessionHandle): AsyncIterable<SessionEvent> {
    const l = this.live.get(h.sessionId); if (!l) throw new Error("unknown session");
    let i = 0;
    while (true) { while (i < l.queue.length) yield l.queue[i++]; if (l.ended) return; await new Promise<void>((r) => l.waiters.push(r)); }
  }
  async send(_h: SessionHandle, _i: SessionInput) { throw new Error("openai runner is single-prompt in Phase 1"); }
  async cancel(h: SessionHandle) { this.live.get(h.sessionId)?.abort.abort(); }
}

function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s); } catch { return { raw: s }; } }
