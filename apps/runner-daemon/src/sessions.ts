import type { Runner, RunnerContext, SessionEvent, SessionHandle, SessionSpec, Grant } from "@jj/core";
import { GrantCache } from "@jj/policy";
import { ClaudeRunner } from "@jj/runner-claude";
import { GeminiRunner } from "@jj/runner-gemini";
import { WorktreeManager } from "./worktrees.js";
import { ApiClient, type ApiLike } from "./api.js";
import { MockRunner } from "@jj/runner-mock";
import { OpenAIRunner } from "@jj/runner-openai";

interface Live {
  runner: Runner;
  handle: SessionHandle;
  buffer: SessionEvent[];
  iterator: AsyncIterator<SessionEvent>;
  parked?: { callId: string; resolve: (ok: boolean) => void };
  spendGbp: number;
  ended: boolean;
  outcome?: string;
}

/** Holds live sessions for this host. The runner daemon is the only process with credentials. */
export class SessionManager {
  private runners: Record<string, Runner>;
  private live = new Map<string, Live>();
  readonly cache = new GrantCache();
  constructor(private api: ApiLike, private worktrees: WorktreeManager, public readonly runnerId: string, runners?: Record<string, Runner>) {
    this.runners = runners ?? (process.env.JJ_MOCK_RUNNER === "1"
      ? { claude: new MockRunner("mock-claude", runnerId), gemini: new MockRunner("mock-gemini", runnerId), openai: new MockRunner("mock-openai", runnerId) }
      : {
          claude: new ClaudeRunner("claude", runnerId),
          gemini: new GeminiRunner("gemini", process.env.GEMINI_BIN ?? "gemini", runnerId),
          ...(process.env.OPENAI_API_KEY ? { openai: new OpenAIRunner("openai", runnerId) } : {}),
        });
  }

  pick(spec: SessionSpec): Runner {
    const v = spec.preferredVendor ?? (spec.reviewerOf ? "gemini" : "claude");
    const r = this.runners[v];
    if (!r) throw new Error(`no runner for vendor ${v}`);
    return r;
  }

  async loadGrants(sessionId: string, grantIds: string[]) {
    const grants: Grant[] = grantIds.length ? await this.api.fetchGrants(grantIds) : [];
    this.cache.load(sessionId, grants);
  }

  async start(spec: SessionSpec) {
    await this.loadGrants(spec.sessionId, spec.grantIds);
    const workdir = await this.worktrees.prepare(spec.sessionId);
    const runner = this.pick(spec);
    const ctx: RunnerContext = {
      checkPolicy: async (c) => {
        const res = this.cache.check(c);
        await this.api.audit({ sessionId: c.sessionId, tool: c.tool, args: c.args, decision: res.decision, grantId: res.grantId, decidedBy: "cache" });
        return res;
      },
      waitForApproval: (sessionId, callId) => new Promise<boolean>((resolve) => {
        const l = this.live.get(sessionId); if (l) l.parked = { callId, resolve }; else resolve(false);
      }),
    };
    const handle = await runner.start({ ...spec, workdir }, ctx);
    const iterator = runner.stream(handle)[Symbol.asyncIterator]();
    this.live.set(spec.sessionId, { runner, handle, buffer: [], iterator, spendGbp: 0, ended: false });
    return handle;
  }

  /**
   * Drain events until the session ends or parks. Posts to the API in batches.
   * Returns what the SessionWorkflow needs to decide what to do next.
   */
  async pump(sessionId: string, fromSeq: number, heartbeat: (seq: number) => void, signal?: AbortSignal) {
    const l = this.live.get(sessionId);
    if (!l) { const e: any = new Error(`SESSION_NOT_LIVE ${sessionId}`); e.code = "SESSION_NOT_LIVE"; throw e; }
    let lastSeq = fromSeq - 1;
    let batch: SessionEvent[] = [];
    let timer: NodeJS.Timeout | undefined;
    let inflight: Promise<void> = Promise.resolve();
    const flush = () => {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (!batch.length) return inflight;
      const b = batch; batch = [];
      inflight = inflight.then(() => this.api.postEvents(b));
      return inflight;
    };
    // Live UI: anything buffered goes out within 150 ms even if the runner is quiet.
    const schedule = () => { if (!timer) timer = setTimeout(() => void flush(), 150); };
    const aborted = () => { const e: any = new Error(`PUMP_ABORTED ${sessionId}`); e.code = "PUMP_ABORTED"; return e; };
    const next = () => signal
      ? Promise.race([l.iterator.next(), new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(aborted()), { once: true }))])
      : l.iterator.next();

    try {
      while (true) {
        if (signal?.aborted) throw aborted();
        const { value, done } = await next();
        if (done) { await flush(); l.ended = true; return { lastSeq, ended: true, spendGbp: l.spendGbp, outcome: l.outcome ?? "complete" }; }
        const e = value as SessionEvent;
        if (e.seq < fromSeq) continue;
        lastSeq = e.seq; batch.push(e); schedule();
        if (e.type === "cost") l.spendGbp = e.cumulativeGbp;
        if (e.type === "done") l.outcome = e.outcome;
        if (batch.length >= 20) await flush();
        heartbeat(lastSeq);
        if (e.type === "approval_request") {
          await flush();
          return { lastSeq, ended: false, parkedCallId: e.callId, parkedGap: e.grantGap, spendGbp: l.spendGbp };
        }
      }
    } finally { await flush().catch(() => undefined); }
  }

  resume(sessionId: string, callId: string, approved: boolean) {
    const l = this.live.get(sessionId);
    if (l?.parked?.callId === callId) { l.parked.resolve(approved); l.parked = undefined; }
  }

  async cancel(sessionId: string, reason: string) {
    const l = this.live.get(sessionId);
    if (l) await l.runner.cancel(l.handle, reason);
  }

  async describe() { return this.runners.claude.capabilities(); }
}
