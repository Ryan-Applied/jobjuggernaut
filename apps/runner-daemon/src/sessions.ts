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
  spec: SessionSpec;
  workdir: string;
  branch?: string;
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

  /** B3: vendor preference, else first vendor that is not avoided and has the required tools. */
  pick(spec: SessionSpec): Runner {
    if (spec.preferredVendor && this.runners[spec.preferredVendor]) return this.runners[spec.preferredVendor];
    const order = spec.reviewerOf ? ["gemini", "openai", "claude"] : ["claude", "openai", "gemini"];
    for (const v of order) {
      const r = this.runners[v]; if (!r) continue;
      if (spec.avoidVendor && v === spec.avoidVendor) continue;
      return r;
    }
    const any = Object.values(this.runners)[0];
    if (!any) throw new Error("no runners configured");
    return any;
  }

  async loadGrants(sessionId: string, grantIds: string[]) {
    const grants: Grant[] = grantIds.length ? await this.api.fetchGrants(grantIds) : [];
    this.cache.load(sessionId, grants);
  }

  async start(spec: SessionSpec) {
    await this.loadGrants(spec.sessionId, spec.grantIds);
    const { dir: workdir, isolation, branch } = await this.worktrees.prepare(spec.sessionId, spec.projectWorkdir, spec.isolation);
    const runner = this.pick(spec);
    const prompt = spec.context ? `${spec.context}\n\n---\n\n# Task\n${spec.prompt}` : spec.prompt;
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
    const handle = await runner.start({ ...spec, workdir, prompt, isolation: isolation as any }, ctx);
    const iterator = runner.stream(handle)[Symbol.asyncIterator]();
    this.live.set(spec.sessionId, { runner, handle, spec, workdir, branch, buffer: [], iterator, spendGbp: 0, ended: false });
    await this.api.postEvents([]).catch(() => undefined);
    await this.api.note(spec.sessionId, { workdir, branch, isolation }).catch(() => undefined);
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
    // Liveness: heartbeat on a timer too. A real session can be silent for minutes on a long tool run.
    const pulse = setInterval(() => { try { heartbeat(lastSeq); } catch {} }, 10_000);
    const aborted = () => { const e: any = new Error(`PUMP_ABORTED ${sessionId}`); e.code = "PUMP_ABORTED"; return e; };
    const next = () => signal
      ? Promise.race([l.iterator.next(), new Promise<never>((_, rej) => signal.addEventListener("abort", () => rej(aborted()), { once: true }))])
      : l.iterator.next();

    try {
      while (true) {
        if (signal?.aborted) throw aborted();
        const { value, done } = await next();
        if (done) {
          await flush(); l.ended = true;
          const rel = await this.worktrees.release(sessionId, l.spec.projectWorkdir, l.outcome ?? "complete").catch((e) => ({ kept: true, reason: String(e) }));
          await this.api.note(sessionId, { worktree: rel }).catch(() => undefined);
          this.live.delete(sessionId);
          return { lastSeq, ended: true, spendGbp: l.spendGbp, outcome: l.outcome ?? "complete" };
        }
        const e = value as SessionEvent;
        if (e.seq < fromSeq) continue;
        lastSeq = e.seq; batch.push(e); schedule();
        if (e.type === "cost") l.spendGbp = e.cumulativeGbp;
        if (e.type === "done") l.outcome = e.outcome;
        if (e.type === "error") l.outcome = "error";
        if (batch.length >= 20) await flush();
        heartbeat(lastSeq);
        if (e.type === "approval_request") {
          await flush();
          return { lastSeq, ended: false, parkedCallId: e.callId, parkedGap: e.grantGap, spendGbp: l.spendGbp };
        }
      }
    } finally { clearInterval(pulse); await flush().catch(() => undefined); }
  }

  async resume(sessionId: string, callId: string, approved: boolean, grantIds?: string[]) {
    if (grantIds?.length) this.cache.append(sessionId, await this.api.fetchGrants(grantIds));
    const l = this.live.get(sessionId);
    if (l?.parked?.callId === callId) { l.parked.resolve(approved); l.parked = undefined; }
  }

  inspect(workdir: string) { return this.worktrees.inspect(workdir); }

  async send(sessionId: string, text: string, final?: boolean) {
    const l = this.live.get(sessionId);
    if (!l) { const e: any = new Error(`SESSION_NOT_LIVE ${sessionId}`); e.code = "SESSION_NOT_LIVE"; throw e; }
    await l.runner.send(l.handle, { text, final });
  }

  /** B3: what this host can do, for the registry. */
  async registry() {
    const caps = await Promise.all(Object.values(this.runners).map((r) => r.capabilities()));
    return { runnerId: this.runnerId, vendors: caps.map((c) => c.vendor), tools: [...new Set(caps.flatMap((c) => c.tools))], host: process.platform, hasChrome: process.platform === "darwin", live: this.live.size };
  }

  async cancel(sessionId: string, reason: string) {
    const l = this.live.get(sessionId);
    if (l) await l.runner.cancel(l.handle, reason);
  }

  async describe() { return this.runners.claude.capabilities(); }
}
