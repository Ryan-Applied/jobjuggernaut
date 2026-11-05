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
import { eventFactory, artifactsFor, costGbp, type Runner, type RunnerContext, type SessionHandle, type SessionSpec, type SessionEvent, type SessionInput, type RunnerCapabilities } from "@jj/core";

const run = promisify(execFile);
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
const COST = { inputPer1k: costGbp(MODEL, 1000, 0), outputPer1k: costGbp(MODEL, 0, 1000) };

const TOOLS: OpenAI.Responses.Tool[] = [
  { type: "function", name: "Bash", description: "Run a shell command in the working directory.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false }, strict: true },
  { type: "function", name: "Read", description: "Read a file relative to the working directory.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
  { type: "function", name: "Write", description: "Write a file relative to the working directory.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, strict: true },
  { type: "function", name: "Edit", description: "Replace an exact string in a file (must occur once).", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"], additionalProperties: false }, strict: true },
  { type: "function", name: "Glob", description: "List files matching a glob under the working directory.", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false }, strict: true },
  { type: "function", name: "Grep", description: "Search file contents with a regex (ripgrep syntax).", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern", "path"], additionalProperties: false }, strict: true },
];

interface Live { queue: SessionEvent[]; waiters: Array<() => void>; ended: boolean; abort: AbortController; emit: ReturnType<typeof eventFactory>; inbox: string[]; inboxWaiters: Array<() => void>; closed: boolean }

export class OpenAIRunner implements Runner {
  readonly id: string;
  private live = new Map<string, Live>();
  private client = new OpenAI();
  constructor(id = "openai", private hostRunnerId = id) { this.id = id; }

  async capabilities(): Promise<RunnerCapabilities> {
    return { runnerId: this.id, vendor: "openai", tools: TOOLS.map((t: any) => t.name), maxContextTokens: 1_000_000, supportsResume: false, supportsSubagents: false, costModel: { ...COST, currency: "GBP" } };
  }

  async start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle> {
    const l: Live = { queue: [], waiters: [], ended: false, abort: new AbortController(), emit: eventFactory(spec.sessionId), inbox: [], inboxWaiters: [], closed: !spec.interactive };
    this.live.set(spec.sessionId, l);
    const push = (e: SessionEvent) => { l.queue.push(e); l.waiters.splice(0).forEach((w) => w()); };
    const end = () => { l.ended = true; l.waiters.splice(0).forEach((w) => w()); };
    push(l.emit({ type: "started", runnerId: this.hostRunnerId, vendor: "openai", vendorSessionRef: `openai-${spec.sessionId}`, workdir: spec.workdir }));

    void (async () => {
      let tokensIn = 0, tokensOut = 0, cumulative = 0;
      let input: OpenAI.Responses.ResponseInput = [{ role: "user", content: spec.prompt }];
      try {
        for (let turn = 0; turn < 60; turn++) {
          if (l.abort.signal.aborted) break;
          const res = await this.client.responses.create({ model: MODEL, instructions: spec.systemPrompt ?? "You are a careful engineering agent working in a sandboxed directory. Use tools when needed, then summarise.", input, tools: TOOLS }, { signal: l.abort.signal });
          tokensIn += res.usage?.input_tokens ?? 0; tokensOut += res.usage?.output_tokens ?? 0;
          cumulative = (tokensIn / 1000) * COST.inputPer1k + (tokensOut / 1000) * COST.outputPer1k;
          push(l.emit({ type: "cost", tokensIn, tokensOut, costGbp: cumulative, cumulativeGbp: cumulative, raw: res.usage }));

          const text = res.output_text;
          if (text) push(l.emit({ type: "message", role: "assistant", text, tokensIn: res.usage?.input_tokens ?? 0, tokensOut: res.usage?.output_tokens ?? 0 }));

          const calls = res.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
          if (!calls.length) {
            // Turn complete. Interactive: wait for a follow-up (or close); otherwise finish.
            if (l.closed && !l.inbox.length) break;
            if (!l.inbox.length) await new Promise<void>((r) => l.inboxWaiters.push(r));
            const next = l.inbox.shift(); if (next === undefined) break;
            push(l.emit({ type: "message", role: "user", text: next }));
            input = [...input, ...res.output, { role: "user", content: next }];
            continue;
          }

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
            const output = ok ? await this.exec(spec.workdir, c.name, args, spec.isolation === "container") : "Blocked by policy: no grant covers this call.";
            push(l.emit({ type: "tool_result", callId: c.call_id, ok, summary: output.slice(0, 160), bytes: output.length }));
            if (ok) for (const a of artifactsFor(c.name, args, output, spec.workdir)) push(l.emit({ type: "artifact", ...a }));
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

  /** B7: with container isolation, shell commands run inside a throwaway container with the workdir mounted. */
  private async sh(cwd: string, cmd: string, container: boolean): Promise<string> {
    const image = process.env.JJ_SANDBOX_IMAGE ?? "node:22-slim";
    const { stdout, stderr } = container
      ? await run("docker", ["run", "--rm", "--network", process.env.JJ_SANDBOX_NETWORK ?? "none", "-v", `${cwd}:/work`, "-w", "/work", image, "sh", "-c", cmd], { timeout: 120_000, maxBuffer: 1 << 20 })
      : await run("sh", ["-c", cmd], { cwd, timeout: 60_000, maxBuffer: 1 << 20 });
    return (stdout + stderr).trim() || "(no output)";
  }
  private async exec(cwd: string, tool: string, args: Record<string, unknown>, container = false): Promise<string> {
    const inside = (p: string) => { const r = resolve(cwd, p); if (!r.startsWith(cwd)) throw new Error("path escapes workdir"); return r; };
    try {
      if (tool === "Bash") return await this.sh(cwd, String(args.cmd), container);
      if (tool === "Glob") return await this.sh(cwd, `find . -path ./node_modules -prune -o -name ${JSON.stringify(String(args.pattern))} -print | head -200`, container);
      if (tool === "Grep") return await this.sh(cwd, `(rg -n ${JSON.stringify(String(args.pattern))} ${JSON.stringify(String(args.path))} 2>/dev/null || grep -rn ${JSON.stringify(String(args.pattern))} ${JSON.stringify(String(args.path))}) | head -200`, container);
      if (tool === "Read") return await readFile(inside(String(args.path)), "utf8");
      if (tool === "Write") { const p = inside(String(args.path)); await mkdir(dirname(p), { recursive: true }); await writeFile(p, String(args.content)); return `wrote ${args.path}`; }
      if (tool === "Edit") { const p = inside(String(args.path)); const t = await readFile(p, "utf8"); const n = t.split(String(args.old)).length - 1; if (n !== 1) return `error: old string occurs ${n} times`; await writeFile(p, t.replace(String(args.old), String(args.new))); return `edited ${args.path}`; }
      return `unknown tool ${tool}`;
    } catch (e) { return `error: ${String(e).slice(0, 500)}`; }
  }

  async *stream(h: SessionHandle): AsyncIterable<SessionEvent> {
    const l = this.live.get(h.sessionId); if (!l) throw new Error("unknown session");
    let i = 0;
    while (true) { while (i < l.queue.length) yield l.queue[i++]; if (l.ended) return; await new Promise<void>((r) => l.waiters.push(r)); }
  }
  async send(h: SessionHandle, i: SessionInput) { const l = this.live.get(h.sessionId); if (!l || l.closed) throw new Error("not interactive"); l.inbox.push(i.text); if (i.final) l.closed = true; l.inboxWaiters.splice(0).forEach((w) => w()); }
  async cancel(h: SessionHandle) { const l = this.live.get(h.sessionId); if (l) { l.closed = true; l.inboxWaiters.splice(0).forEach((w) => w()); l.abort.abort(); } }
}

function safeJson(s: string): Record<string, unknown> { try { return JSON.parse(s); } catch { return { raw: s }; } }
