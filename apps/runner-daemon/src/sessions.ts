import type { Runner, RunnerContext, SessionEvent, SessionHandle, SessionSpec, Grant } from "@jj/core";
import { GrantCache } from "@jj/policy";
import { ClaudeRunner } from "@jj/runner-claude";
import { GeminiRunner } from "@jj/runner-gemini";
import { WorktreeManager } from "./worktrees.js";
import { ApiClient } from "./api.js";

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
  constructor(private api: ApiClient, private worktrees: WorktreeManager, public readonly runnerId: string) {
    this.runners = { claude: new ClaudeRunner("claude", runnerId), gemini: new GeminiRunner("gemini", process.env.GEMINI_BIN ?? "gemini", runnerId) };
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
  async pump(sessionId: string, fromSeq: number, heartbeat: (seq: number) => void) {
    const l = this.live.get(sessionId);
    if (!l) throw new Error(`session ${sessionId} not live on this host (restart lost it; workflow will retry start)`);
    let lastSeq = fromSeq - 1;
    let batch: SessionEvent[] = [];
    const flush = async () => { if (batch.length) { await this.api.postEvents(batch); batch = []; } };

    while (true) {
      const { value, done } = await l.iterator.next();
      if (done) { await flush(); l.ended = true; return { lastSeq, ended: true, spendGbp: l.spendGbp, outcome: l.outcome ?? "complete" }; }
      const e = value as SessionEvent;
      if (e.seq < fromSeq) continue;
      lastSeq = e.seq; batch.push(e);
      if (e.type === "cost") l.spendGbp = e.cumulativeGbp;
      if (e.type === "done") l.outcome = e.outcome;
      if (batch.length >= 20) await flush();
      heartbeat(lastSeq);
      if (e.type === "approval_request") {
        await flush();
        return { lastSeq, ended: false, parkedCallId: e.callId, parkedGap: e.grantGap, spendGbp: l.spendGbp };
      }
    }
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
