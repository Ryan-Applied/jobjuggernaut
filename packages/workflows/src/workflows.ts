import { proxyActivities, setHandler, condition, workflowInfo, executeChild, startChild, ParentClosePolicy, CancellationScope, isCancellation, uuid4, ApplicationFailure, sleep } from "@temporalio/workflow";
import type { LocalActivities, CloudActivities, IndexerActivities } from "./activities.js";
import { approveSignal, cancelSignal, continueSignal, pauseSignal, nudgeSignal, ledgerSignedSignal, batchStatusQuery, statusQuery, taskStatusQuery, CLOUD_QUEUE, INDEXER_QUEUE, localQueue, type SessionStatus, type TaskDefinition, type TaskStatus, type BatchStatus, type ApprovalMode } from "./shared.js";
import type { SessionSpec } from "@jj/core";

const cloud = proxyActivities<CloudActivities>({
  taskQueue: CLOUD_QUEUE,
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

const indexer = proxyActivities<IndexerActivities>({
  taskQueue: INDEXER_QUEUE,
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 3, initialInterval: "5 seconds" },
});

/** Embed, link, extract lessons for one finished session; then reassess the project it belongs to. */
export async function IndexWorkflow(input: { sessionId: string }) {
  const r = await indexer.indexSession(input);
  const { projectId } = await cloud.sessionProject(input);
  // D1: model-written lessons on the project's runner (falls back to the heuristic ones already stored)
  const li = await indexer.lessonInputs(input).catch(() => undefined);
  if (li?.runnerId) {
    const written = await localFor(li.runnerId).writeLessons({ summary: li.summary, neighbours: li.neighbours, heuristic: li.heuristic }).catch(() => undefined);
    if (written?.lessons?.length) await indexer.storeLessons({ sessionId: input.sessionId, lessons: written.lessons });
  }
  if (projectId) await executeChild(ProgressWorkflow, { args: [{ projectId }], workflowId: `progress-${projectId}-${input.sessionId.slice(0, 8)}` }).catch(() => undefined);
  return r;
}

/** LLM progress assessment for a project, run on the project's runner (files + key live there). */
export async function ProgressWorkflow(input: { projectId: string }) {
  const inputs = await cloud.progressInputs(input);
  if (!inputs) return { skipped: "no project" };
  const local = localFor(inputs.runnerId);
  const assessment = await local.assessProgress(inputs);
  await cloud.storeProgress({ projectId: input.projectId, assessment });
  return assessment;
}

export async function IngestProjectWorkflow(input: { workdir?: string; hint?: string; runnerId: string }) {
  return localFor(input.runnerId).draftProject({ workdir: input.workdir, hint: input.hint });
}
export async function IngestWorkflowWorkflow(input: { text?: string; path?: string; runnerId: string }) {
  return localFor(input.runnerId).draftWorkflow({ text: input.text, path: input.path });
}

/** Nightly: proposals for every workflow. Scheduled by the API (Phase 4). */
export async function NightlyLearnWorkflow() {
  const ids = await indexer.listWorkflowIds();
  let proposals = 0;
  for (const workflowId of ids) proposals += (await indexer.proposeForWorkflow({ workflowId })).proposals;
  const { deleted } = await indexer.compactEvents().catch(() => ({ deleted: 0 }));
  return { workflows: ids.length, proposals, compactedEvents: deleted };
}

function localFor(runnerId: string) {
  return proxyActivities<LocalActivities>({
    taskQueue: localQueue(runnerId),
    startToCloseTimeout: "4 hours",
    scheduleToStartTimeout: "2 minutes",
    heartbeatTimeout: "90 seconds",
    retry: { maximumAttempts: 3, initialInterval: "2 seconds", nonRetryableErrorTypes: ["SESSION_NOT_LIVE"] },
  });
}

export interface SessionWorkflowInput { spec: SessionSpec; runnerId: string; title: string }

/**
 * One agent session, end to end. Survives the runner daemon restarting:
 * pumpEvents resumes from lastSeq. Parks on approval_request and waits for the approve signal.
 */
export async function SessionWorkflow(input: SessionWorkflowInput): Promise<SessionStatus> {
  const local = localFor(input.runnerId);
  const status: SessionStatus = { state: "starting", lastSeq: -1, spendGbp: 0, restarts: 0 };
  let decision: { callId: string; mode: ApprovalMode; grantIds?: string[] } | undefined;
  let cancelReason: string | undefined;
  const nudges: Array<{ text: string; final?: boolean }> = [];

  setHandler(statusQuery, () => status);
  setHandler(nudgeSignal, (text, final) => { nudges.push({ text, final }); });
  setHandler(approveSignal, (callId, mode, grantIds) => { decision = { callId, mode, grantIds }; });
  setHandler(cancelSignal, (reason) => { cancelReason = reason; });

  await cloud.createSessionNode({ sessionId: input.spec.sessionId, title: input.title, props: { state: "starting", runnerId: input.runnerId, workflowId: input.spec.workflowId, taskId: input.spec.taskId, projectId: input.spec.projectId, mode: input.spec.mode, prompt: input.spec.prompt, skills: input.spec.skills, grantIds: input.spec.grantIds, stepIndex: input.spec.stepIndex, vendor: input.spec.preferredVendor } });
  await cloud.linkSessionToWorkflow({ sessionId: input.spec.sessionId, workflowId: input.spec.workflowId, taskId: input.spec.taskId });

  await local.startSession(input.spec);
  status.state = "running"; status.vendor = input.spec.preferredVendor;

  try {
    while (true) {
      if (cancelReason) {
        await local.cancelSession({ sessionId: input.spec.sessionId, reason: cancelReason });
        status.state = "cancelled"; status.outcome = "cancelled";
        break;
      }
      let r;
      try {
        // Race the pump against a cancel signal so a quiet session can still be cancelled promptly.
        const pump = local.pumpEvents({ sessionId: input.spec.sessionId, fromSeq: status.lastSeq + 1 });
        // B1: deliver nudges while the pump runs
        const pumpSettled = pump.then(() => false, () => false);
        const nudger = (async () => { while (true) { const got = await Promise.race([pumpSettled, condition(() => nudges.length > 0).then(() => true)]); if (!got) return; const n = nudges.shift()!; await local.sendToSession({ sessionId: input.spec.sessionId, ...n }).catch(() => undefined); } })();
        const cancelled = await Promise.race([pumpSettled, condition(() => !!cancelReason).then(() => true)]);
        void nudger;
        if (cancelled) {
          await local.cancelSession({ sessionId: input.spec.sessionId, reason: cancelReason! });
          r = await pump; // runner emits done:cancelled and the pump drains it
          status.lastSeq = r.lastSeq; status.spendGbp = r.spendGbp;
          status.state = "cancelled"; status.outcome = "cancelled";
          break;
        }
        r = await pump;
      } catch (err) {
        if (isNotLive(err) && status.restarts < 3) {
          status.restarts += 1; status.state = "starting";
          await local.startSession(input.spec);
          status.state = "running"; status.lastSeq = -1;
          continue;
        }
        throw err;
      }
      status.lastSeq = r.lastSeq; status.spendGbp = r.spendGbp;
      if (r.ended) { status.outcome = r.outcome; status.state = r.outcome === "error" ? "error" : r.outcome === "cancelled" ? "cancelled" : "done"; break; }
      if (r.parkedCallId) {
        status.state = "parked"; status.parkedCallId = r.parkedCallId; status.parkedGap = r.parkedGap;
        await cloud.postSlackCard({ sessionId: input.spec.sessionId, callId: r.parkedCallId, gap: r.parkedGap ?? "" });
        await condition(() => decision?.callId === r.parkedCallId || !!cancelReason);
        if (cancelReason) continue;
        const approved = decision!.mode !== "deny";
        const grantIds = decision!.mode === "widen" ? decision!.grantIds : undefined;
        decision = undefined;
        await local.resumeSession({ sessionId: input.spec.sessionId, callId: r.parkedCallId, approved, grantIds });
        status.state = "running"; status.parkedCallId = undefined; status.parkedGap = undefined;
      }
    }
  } catch (err) {
    if (isCancellation(err)) throw err;
    status.state = "error"; status.outcome = String(err);
  }

  await cloud.recordOutcome({ sessionId: input.spec.sessionId, outcome: status.outcome ?? status.state, spendGbp: status.spendGbp });
  if (status.state === "done") await cloud.startIndexing({ sessionId: input.spec.sessionId });
  return status;
}

/** C1: topological waves. Steps with no `after` form wave 0; a step joins the wave after all its deps. Unknown deps are ignored. */
export function waves(steps: TaskDefinition["steps"]): number[][] {
  const names = steps.map((s) => s.name);
  const level = new Array(steps.length).fill(-1);
  const lvl = (i: number, seen = new Set<number>()): number => {
    if (level[i] >= 0) return level[i]; if (seen.has(i)) return 0; seen.add(i);
    const deps = (steps[i].after ?? []).map((n) => names.indexOf(n)).filter((j) => j >= 0 && j !== i);
    level[i] = deps.length ? Math.max(...deps.map((j) => lvl(j, seen))) + 1 : (steps[i].after ? 0 : (i === 0 || steps.slice(0, i).every((p) => p.after) ? 0 : -2));
    return level[i];
  };
  // Legacy serial semantics: steps without `after` run strictly after the previous step unless any step declares `after`.
  const dag = steps.some((s) => s.after);
  if (!dag) return steps.map((_, i) => [i]);
  steps.forEach((_, i) => lvl(i));
  const out: number[][] = [];
  steps.forEach((_, i) => { const L = Math.max(0, level[i]); (out[L] ??= []).push(i); });
  return out.filter(Boolean);
}

/** Runs a task's steps as waves of child SessionWorkflows. Assist mode waits for a go-ahead between waves. */
export async function TaskWorkflow(def: TaskDefinition): Promise<{ outcomes: SessionStatus[] }> {
  const outcomes: SessionStatus[] = [];
  const status: TaskStatus = { stepIndex: 0, state: "running", sessionIds: [], spendGbp: 0, wave: 0 };
  let goAhead: { stepIndex: number; go: boolean } | undefined;
  let paused = false;
  setHandler(taskStatusQuery, () => status);
  setHandler(continueSignal, (stepIndex, go) => { goAhead = { stepIndex, go }; });
  setHandler(pauseSignal, (p) => { paused = p; });

  let context = def.context ?? "";
  if (def.projectId) {
    const graphSide = await cloud.projectContext({ projectId: def.projectId }).catch(() => "");
    const local = localFor(def.runnerId);
    const ws = def.projectWorkdir ? await local.inspectWorkdir({ workdir: def.projectWorkdir }).catch(() => undefined) : undefined;
    const wsText = ws ? [`Workdir: ${def.projectWorkdir}${ws.isRepo ? ` (git, branch ${ws.branch}, ${ws.dirty ?? 0} dirty files)` : " (folder)"}`,
      ws.recentCommits?.length ? `Recent commits:\n${ws.recentCommits.map((c) => "  " + c).join("\n")}` : "",
      ws.openBranches?.length ? `Branches: ${ws.openBranches.join(", ")}` : "", ws.hasClaudeMd ? "CLAUDE.md present; follow it." : ""].filter(Boolean).join("\n") : "";
    context = [context, graphSide, wsText].filter(Boolean).join("\n\n");
  }
  await cloud.markTask({ taskId: def.taskId, state: "running", extra: { contextChars: context.length } });

  const deadlineAt = def.deadline ? Date.parse(def.deadline) : undefined;
  const budget = def.budgetGbp ?? def.steps.reduce((a, s) => a + s.maxCostGbp, 0) * 1.1;
  const sessionVendor = new Map<number, string | undefined>();
  const plan = waves(def.steps);
  const finish = async (state: TaskStatus["state"]) => { status.state = state; await cloud.markTask({ taskId: def.taskId, state, extra: { spendGbp: status.spendGbp } }); return { outcomes }; };

  const runStep = async (i: number, prevSession?: string): Promise<SessionStatus> => {
    const step = def.steps[i];
    const remaining = Math.max(0.05, budget - status.spendGbp);
    const attempts = (step.retry ?? 0) + 1;
    let out: SessionStatus = { state: "error", lastSeq: -1, spendGbp: 0, restarts: 0 };
    for (let a = 0; a < attempts; a++) {
      const sessionId = uuid4();
      status.sessionIds.push(sessionId); status.stepIndex = i;
      const spec: SessionSpec = {
        sessionId, workflowId: def.workflowId, taskId: def.taskId, projectId: def.projectId, mode: def.mode ?? "assist", stepIndex: i,
        prompt: a > 0 ? `${step.prompt}\n\n(Retry ${a} of ${attempts - 1}: the previous attempt ended with ${out.outcome ?? out.state}.)` : step.prompt,
        context: context || undefined, skills: step.skills ?? [], connectors: step.connectors ?? [],
        grantIds: def.grantIds, workdir: `${def.taskId}/${i}`, projectWorkdir: def.projectWorkdir,
        budget: { maxCostGbp: Math.min(step.maxCostGbp, remaining), deadline: def.deadline }, requires: step.requires ?? [],
        preferredVendor: step.preferredVendor, reviewerOf: step.reviewerOfPrevious ? prevSession : undefined,
        avoidVendor: step.reviewerOfPrevious && prevSession ? sessionVendor.get(i - 1) as any : undefined,
        interactive: step.interactive, idleMinutes: step.idleMinutes,
      };
      out = await executeChild(SessionWorkflow, { args: [{ spec, runnerId: def.runnerId, title: `${def.title}: ${step.name}` }], workflowId: `session-${sessionId}` });
      status.spendGbp += out.spendGbp; sessionVendor.set(i, out.vendor ?? step.preferredVendor);
      outcomes.push(out);
      if (out.state === "done") return out;
      if (out.state === "cancelled") return out;
    }
    return out;
  };

  let prevSession: string | undefined;
  const ran = new Set<number>();
  for (let w = 0; w < plan.length; w++) {
    status.wave = w;
    if (paused) { status.state = "paused"; await cloud.markTask({ taskId: def.taskId, state: "paused" }); await condition(() => !paused); status.state = "running"; }
    if (def.mode === "assist" && w > 0) {
      const first = plan[w][0];
      status.state = "awaiting_go_ahead"; status.stepIndex = first;
      await cloud.markTask({ taskId: def.taskId, state: "awaiting_go_ahead", extra: { stepIndex: first, stepName: def.steps[first].name } });
      await condition(() => goAhead?.stepIndex === first);
      if (!goAhead!.go) return finish("stopped");
      goAhead = undefined; status.state = "running";
    }
    if (status.spendGbp >= budget) return finish("over_budget");
    if (deadlineAt && Date.now() >= deadlineAt) return finish("deadline");

    const todo = plan[w].filter((i) => !ran.has(i));
    const results = await Promise.all(todo.map((i) => runStep(i, prevSession)));
    todo.forEach((i) => ran.add(i));
    prevSession = status.sessionIds[status.sessionIds.length - 1];
    for (let k = 0; k < results.length; k++) {
      const i = todo[k]; const r = results[k];
      if (r.state === "done") continue;
      if (r.state === "cancelled") return finish("stopped");
      const action = def.steps[i].onFailure ?? "stop";
      if (action === "continue") continue;
      if (action.startsWith("run:")) {
        const j = def.steps.findIndex((s) => s.name === action.slice(4));
        if (j >= 0) { const comp = await runStep(j, prevSession); ran.add(j); if (comp.state !== "done") return finish("stopped"); continue; }
      }
      return finish("stopped");
    }
  }
  return finish("done");
}

/**
 * Overnight batch. Started by a Temporal Schedule at 22:00 (or on demand).
 * Signed tasks start immediately under a concurrency limit; unsigned ones wait for a
 * ledgerSigned signal until the sign-off deadline, then are skipped and reported.
 */
export async function OvernightBatchWorkflow(input: { until: string; signDeadlineMinutes?: number; concurrency?: number }) {
  const status: BatchStatus = { started: [], skipped: [], waitingFor: [] };
  const signed = new Map<string, string[]>();
  setHandler(batchStatusQuery, () => status);
  setHandler(ledgerSignedSignal, (taskId, grantIds) => { signed.set(taskId, grantIds); });

  const until = input.until.startsWith("+") ? new Date(Date.now() + Number(input.until.slice(1, -1)) * 3600_000).toISOString() : input.until;
  const tasks = (await cloud.tonightTasks({ until })).sort((a, b) => (b.def.priority ?? 0) - (a.def.priority ?? 0));
  for (const t of tasks) if (t.signedGrantIds) signed.set(t.def.taskId, t.signedGrantIds); else status.waitingFor.push(t.def.taskId);

  const limit = input.concurrency ?? 3;
  const perRunner = new Map<string, number>();
  const launched: Promise<unknown>[] = [];
  const launch = async (def: TaskDefinition, grantIds: string[]) => {
    // C6: "any" affinity asks the registry for a live runner with room; "fixed" uses def.runnerId.
    const runnerId = def.runnerAffinity === "any" ? (await cloud.pickRunner({ requires: def.steps.flatMap((s) => s.requires ?? []) })) ?? def.runnerId : def.runnerId;
    await condition(() => (perRunner.get(runnerId) ?? 0) < limit);
    perRunner.set(runnerId, (perRunner.get(runnerId) ?? 0) + 1);
    status.started.push(def.taskId);
    const h = await startChild(TaskWorkflow, { args: [{ ...def, runnerId, grantIds, mode: def.mode ?? "auto" }], workflowId: `task-${def.taskId}`, parentClosePolicy: ParentClosePolicy.ABANDON });
    launched.push(h.result().finally(() => { perRunner.set(runnerId, (perRunner.get(runnerId) ?? 1) - 1); }));
  };

  for (const t of tasks) if (signed.has(t.def.taskId)) await launch(t.def, signed.get(t.def.taskId)!);

  const deadlineMs = (input.signDeadlineMinutes ?? 90) * 60_000;
  while (status.waitingFor.length) {
    const got = await condition(() => status.waitingFor.some((id) => signed.has(id)), deadlineMs);
    if (!got) { for (const id of status.waitingFor) { status.skipped.push({ taskId: id, reason: "ledger not signed by deadline" }); await cloud.markTask({ taskId: id, state: "skipped", extra: { reason: "unsigned" } }); } status.waitingFor = []; break; }
    for (const id of [...status.waitingFor]) if (signed.has(id)) {
      status.waitingFor = status.waitingFor.filter((x) => x !== id);
      const t = tasks.find((x) => x.def.taskId === id)!;
      await launch(t.def, signed.get(id)!);
    }
  }
  await Promise.allSettled(launched);
  status.finishedAt = new Date().toISOString();
  return status;
}

/** One fire of a chore schedule. */
export async function ChoreRunWorkflow(input: { choreId: string }) {
  const m = await cloud.materialiseChore(input);
  if ("skipped" in m) return { skipped: m.skipped };
  return executeChild(TaskWorkflow, { args: [m.def], workflowId: `task-${m.def.taskId}` });
}

function isNotLive(err: unknown): boolean {
  const walk = (e: any): boolean => !!e && (String(e.message ?? "").includes("SESSION_NOT_LIVE") || walk(e.cause));
  return walk(err) || (err instanceof ApplicationFailure && String(err.message).includes("SESSION_NOT_LIVE"));
}

export { workflowInfo, CancellationScope, sleep };
