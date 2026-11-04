/**
 * Phase 1 exit test, vendor-free. Needs a Temporal server on TEMPORAL_ADDRESS (default localhost:7233).
 * Runs the real SessionWorkflow/TaskWorkflow code on an in-process cloud worker with in-memory
 * cloud activities, and the real SessionManager + MockRunner on an in-process local worker.
 *
 *   pnpm --filter @jj/runner-daemon test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Worker, NativeConnection, Runtime } from "@temporalio/worker";
import { Context, ApplicationFailure } from "@temporalio/activity";
import { Connection, Client } from "@temporalio/client";
import { fileURLToPath } from "node:url";
import type { SessionEvent, Grant } from "@jj/core";
import type { LocalActivities, CloudActivities, TaskDefinition } from "@jj/workflows";
import { approveSignal, cancelSignal, statusQuery, TaskWorkflow, CLOUD_QUEUE, localQueue } from "@jj/workflows";
import { MockRunner } from "@jj/runner-mock";
import { SessionManager } from "./sessions.js";
import { WorktreeManager } from "./worktrees.js";
import type { ApiLike } from "./api.js";

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_TEST_NAMESPACE ?? "jj-test";
// Queue names are compiled into the workflow bundle, so the test uses the real ones but in its own
// namespace (created below), so it never shares tasks with a running dev stack.
const RUNNER_ID = `test-${process.pid}`;
const LOCAL_QUEUE = localQueue(RUNNER_ID);
const WF = "00000000-0000-4000-8000-000000000001";

// In-memory stand-ins for Postgres and the API.
const events: SessionEvent[] = [];
const grants = new Map<string, Grant>();
const audit: Array<{ tool: string; decision: string }> = [];
const parked: Array<{ sessionId: string; callId: string; gap: string }> = [];
const nodes = new Map<string, Record<string, unknown>>();

const api: ApiLike = {
  async postEvents(batch) { events.push(...batch); },
  async fetchGrants(ids) { return ids.map((id) => grants.get(id)).filter((g): g is Grant => !!g); },
  async audit(row) { audit.push({ tool: row.tool, decision: row.decision }); },
};

function cloudActivities(): CloudActivities {
  return {
    async createSessionNode({ sessionId, title, props }) { nodes.set(sessionId, { title, ...props }); },
    async linkSessionToWorkflow() {},
    async recordOutcome({ sessionId, outcome, spendGbp }) { nodes.set(sessionId, { ...nodes.get(sessionId), outcome, spendGbp }); },
    async postSlackCard(p) { parked.push(p); },
    async startIndexing() {},
    async projectContext() { return ""; },
    async markTask() {},
    async tonightTasks() { return []; },
    async sessionProject() { return {}; },
    async progressInputs() { return undefined; },
    async storeProgress() {},
    async materialiseChore() { return { skipped: "test" }; },
  };
}

function localActivities(manager: SessionManager): LocalActivities {
  return {
    draftProject: async () => { throw new Error("not in this test"); },
    draftWorkflow: async () => { throw new Error("not in this test"); },
    assessProgress: async () => { throw new Error("not in this test"); },
    describeRunner: () => manager.describe(),
    startSession: async (spec) => ({ vendorSessionRef: (await manager.start(spec)).vendorSessionRef }),
    pumpEvents: ({ sessionId, fromSeq }) => manager.pump(sessionId, fromSeq, (seq) => Context.current().heartbeat(seq), Context.current().cancellationSignal).catch((e) => {
      if (e?.code === "SESSION_NOT_LIVE") throw ApplicationFailure.nonRetryable(e.message, "SESSION_NOT_LIVE");
      throw e;
    }),
    resumeSession: ({ sessionId, callId, approved, grantIds }) => manager.resume(sessionId, callId, approved, grantIds),
    inspectWorkdir: ({ workdir }) => manager.inspect(workdir),
    cancelSession: ({ sessionId, reason }) => manager.cancel(sessionId, reason),
  };
}

const workflowsPath = fileURLToPath(new URL("../../../packages/workflows/dist/workflows.js", import.meta.url));

let connection: NativeConnection;
let client: Client;
let cloud: Worker;
let local: Worker;
let manager: SessionManager;
let localRun: Promise<void>;
let cloudRun: Promise<void>;

async function startLocal() {
  manager = new SessionManager(api, new WorktreeManager(`/tmp/jj-test-${process.pid}`), RUNNER_ID, {
    claude: new MockRunner("mock-claude", RUNNER_ID), gemini: new MockRunner("mock-gemini", RUNNER_ID),
  });
  local = await Worker.create({ connection, namespace: NAMESPACE, taskQueue: LOCAL_QUEUE, activities: localActivities(manager), shutdownGraceTime: "200ms" });
  localRun = local.run();
}

beforeAll(async () => {
  Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } as any });
  const conn = await Connection.connect({ address: ADDRESS });
  await conn.workflowService.registerNamespace({ namespace: NAMESPACE, workflowExecutionRetentionPeriod: { seconds: 86400 as any } }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1500)); // namespace propagation on the dev server
  connection = await NativeConnection.connect({ address: ADDRESS });
  client = new Client({ connection: conn, namespace: NAMESPACE });
  cloud = await Worker.create({ connection, namespace: NAMESPACE, taskQueue: CLOUD_QUEUE, workflowsPath, activities: cloudActivities() });
  cloudRun = cloud.run();
  await startLocal();
}, 120_000);

afterAll(async () => {
  cloud?.shutdown(); local?.shutdown();
  await Promise.allSettled([cloudRun, localRun]);
  await connection?.close();
});

function task(title: string, prompt: string, extra: Partial<TaskDefinition["steps"][number]> = {}, grantIds: string[] = []): TaskDefinition {
  return { taskId: crypto.randomUUID(), workflowId: WF, title, runnerId: RUNNER_ID, grantIds, steps: [{ name: "s", prompt, maxCostGbp: 1, ...extra }] };
}
const start = (def: TaskDefinition) => client.workflow.start(TaskWorkflow, { args: [def], taskQueue: CLOUD_QUEUE, workflowId: `task-${def.taskId}` });
const sessionIdOf = (taskId: string) => events.find((e) => e.type === "started" && (nodes.get(e.sessionId) as any)?.taskId === taskId)?.sessionId;
const waitFor = async (pred: () => boolean, ms = 20_000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

describe("Phase 1 exit test (mock runner, real Temporal)", () => {
  it("runs 5 sessions in parallel across 2 vendors, all visible within 2 s", async () => {
    const defs = [
      task("claude 1", "hello"), task("claude 2", "hello"), task("claude 3", "hello"),
      task("gemini 1", "review", { preferredVendor: "gemini" }), task("gemini 2", "review", { preferredVendor: "gemini" }),
    ];
    const t0 = Date.now();
    const handles = await Promise.all(defs.map(start));
    await waitFor(() => defs.every((d) => sessionIdOf(d.taskId)), 10_000);
    const visibleMs = Date.now() - t0;
    const results = await Promise.all(handles.map((h) => h.result()));
    expect(results.every((r) => r.outcomes[0].state === "done")).toBe(true);
    const refs = defs.map((d) => (events.find((e) => e.type === "started" && e.sessionId === sessionIdOf(d.taskId)) as any).vendorSessionRef);
    expect(refs.filter((r: string) => r.startsWith("mock-")).length).toBe(5);
    console.log(`all 5 visible in ${visibleMs} ms`);
    expect(visibleMs).toBeLessThan(2000);
  }, 60_000);

  it("parks a tool call with no grant, resumes on approve, records the decision", async () => {
    const def = task("park", "tool:Bash");
    const h = await start(def);
    await waitFor(() => parked.some((p) => p.gap.includes("no grant for Bash")));
    const p = parked.find((p) => p.gap.includes("no grant for Bash"))!;
    const st = await client.workflow.getHandle(`session-${p.sessionId}`).query(statusQuery);
    expect(st.state).toBe("parked");
    await client.workflow.getHandle(`session-${p.sessionId}`).signal(approveSignal, p.callId, "once");
    const r = await h.result();
    expect(r.outcomes[0].state).toBe("done");
    const mine = events.filter((e) => e.sessionId === p.sessionId);
    expect(mine.some((e) => e.type === "tool_call" && e.policyDecision === "park")).toBe(true);
    expect(mine.some((e) => e.type === "tool_result" && e.ok)).toBe(true);
    expect(audit.some((a) => a.tool === "Bash" && a.decision === "park")).toBe(true);
  }, 60_000);

  it("allows a tool call inside a signed grant without parking", async () => {
    const g: Grant = { id: crypto.randomUUID(), ledgerId: crypto.randomUUID(), action: "Bash", scope: { cmd: "ls*" }, cap: { count: 3 }, used: { count: 0, gbp: 0 }, expiresAt: new Date(Date.now() + 3600_000).toISOString(), delegated: false };
    grants.set(g.id, g);
    const def = task("granted", "tool:Bash", {}, [g.id]);
    const r = await (await start(def)).result();
    expect(r.outcomes[0].state).toBe("done");
    const sid = sessionIdOf(def.taskId)!;
    expect(events.some((e) => e.sessionId === sid && e.type === "tool_call" && e.policyDecision === "allow" && e.grantId === g.id)).toBe(true);
    expect(events.some((e) => e.sessionId === sid && e.type === "approval_request")).toBe(false);
  }, 60_000);

  it("deny from the approver blocks the tool and the session still completes", async () => {
    const def = task("denied", "tool:gmail.send");
    const h = await start(def);
    await waitFor(() => parked.some((p) => p.gap.includes("no grant for gmail.send")));
    const p = parked.find((p) => p.gap.includes("no grant for gmail.send"))!;
    await client.workflow.getHandle(`session-${p.sessionId}`).signal(approveSignal, p.callId, "deny");
    const r = await h.result();
    expect(r.outcomes[0].state).toBe("done");
    expect(events.some((e) => e.sessionId === p.sessionId && e.type === "tool_result" && !e.ok)).toBe(true);
  }, 60_000);

  it("cancels a running session from a signal", async () => {
    const def = task("cancel me", "slow:4000 slow:4000");
    const h = await start(def);
    await waitFor(() => !!sessionIdOf(def.taskId));
    const sid = sessionIdOf(def.taskId)!;
    await client.workflow.getHandle(`session-${sid}`).signal(cancelSignal, "test");
    const r = await h.result();
    expect(r.outcomes[0].state).toBe("cancelled");
  }, 60_000);

  it("survives the runner daemon restarting mid-session by restarting the session", async () => {
    const def = task("restart me", "slow:6000");
    const h = await start(def);
    await waitFor(() => !!sessionIdOf(def.taskId));
    // Kill the local worker: in-memory sessions are gone, exactly like Ctrl-C on the daemon.
    local.shutdown(); await localRun;
    await startLocal();
    const r = await h.result();
    expect(r.outcomes[0].state).toBe("done");
    expect(r.outcomes[0].restarts).toBeGreaterThanOrEqual(1);
    const sid = sessionIdOf(def.taskId)!;
    expect(events.filter((e) => e.sessionId === sid && e.type === "started").length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
