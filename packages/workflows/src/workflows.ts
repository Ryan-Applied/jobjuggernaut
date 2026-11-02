import { proxyActivities, setHandler, condition, workflowInfo, executeChild, startChild, ParentClosePolicy, CancellationScope, isCancellation, uuid4, ApplicationFailure } from "@temporalio/workflow";
import type { LocalActivities, CloudActivities, IndexerActivities } from "./activities.js";
import { approveSignal, cancelSignal, continueSignal, ledgerSignedSignal, batchStatusQuery, statusQuery, taskStatusQuery, CLOUD_QUEUE, INDEXER_QUEUE, localQueue, type SessionStatus, type TaskDefinition, type TaskStatus, type BatchStatus, type ApprovalMode } from "./shared.js";
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

/** Embed, link, extract lessons for one finished session. */
export async function IndexWorkflow(input: { sessionId: string }) {
  return indexer.indexSession(input);
}

/** Nightly: proposals for every workflow. Scheduled by the API (Phase 4). */
export async function NightlyLearnWorkflow() {
  const ids = await indexer.listWorkflowIds();
  let proposals = 0;
  for (const workflowId of ids) proposals += (await indexer.proposeForWorkflow({ workflowId })).proposals;
  return { workflows: ids.length, proposals };
}

function localFor(runnerId: string) {
  return proxyActivities<LocalActivities>({
    taskQueue: localQueue(runnerId),
    startToCloseTimeout: "4 hours",
    heartbeatTimeout: "30 seconds",
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

  setHandler(statusQuery, () => status);
  setHandler(approveSignal, (callId, mode, grantIds) => { decision = { callId, mode, grantIds }; });
  setHandler(cancelSignal, (reason) => { cancelReason = reason; });

  await cloud.createSessionNode({ sessionId: input.spec.sessionId, title: input.title, props: { state: "starting", runnerId: input.runnerId, workflowId: input.spec.workflowId, taskId: input.spec.taskId, projectId: input.spec.projectId, mode: input.spec.mode, prompt: input.spec.prompt, skills: input.spec.skills, grantIds: input.spec.grantIds, stepIndex: input.spec.stepIndex, vendor: input.spec.preferredVendor } });
  await cloud.linkSessionToWorkflow({ sessionId: input.spec.sessionId, workflowId: input.spec.workflowId, taskId: input.spec.taskId });

  await local.startSession(input.spec);
  status.state = "running";

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
        const cancelled = await Promise.race([pump.then(() => false), condition(() => !!cancelReason).then(() => true)]);
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
      if (r.ended) { status.state = "done"; status.outcome = r.outcome; break; }
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

/** Runs a task's steps in order, each as a child SessionWorkflow. Assist mode waits for a go-ahead between steps. */
export async function TaskWorkflow(def: TaskDefinition): Promise<{ outcomes: SessionStatus[] }> {
  const outcomes: SessionStatus[] = [];
  const status: TaskStatus = { stepIndex: 0, state: "running", sessionIds: [] };
  let goAhead: { stepIndex: number; go: boolean } | undefined;
  setHandler(taskStatusQuery, () => status);
  setHandler(continueSignal, (stepIndex, go) => { goAhead = { stepIndex, go }; });

  // Continuation pack: graph context (cloud) + workdir inspection (local), prepended to every step's prompt.
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

  let previousSessionId: string | undefined;
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    if (def.mode === "assist" && i > 0) {
      status.state = "awaiting_go_ahead"; status.stepIndex = i;
      await cloud.markTask({ taskId: def.taskId, state: "awaiting_go_ahead", extra: { stepIndex: i, stepName: step.name } });
      await condition(() => goAhead?.stepIndex === i);
      if (!goAhead!.go) { status.state = "stopped"; await cloud.markTask({ taskId: def.taskId, state: "stopped" }); return { outcomes }; }
      goAhead = undefined; status.state = "running";
    }
    const sessionId = uuid4();
    status.sessionIds.push(sessionId); status.stepIndex = i;
    const spec: SessionSpec = {
      sessionId, workflowId: def.workflowId, taskId: def.taskId, projectId: def.projectId, mode: def.mode ?? "assist", stepIndex: i,
      prompt: step.prompt, systemPrompt: undefined, context: context || undefined,
      skills: step.skills ?? [], connectors: step.connectors ?? [],
      grantIds: def.grantIds, workdir: `${def.taskId}/${i}`, projectWorkdir: def.projectWorkdir,
      budget: { maxCostGbp: step.maxCostGbp }, requires: step.requires ?? [],
      preferredVendor: step.preferredVendor,
      reviewerOf: step.reviewerOfPrevious ? previousSessionId : undefined,
    };
    const out = await executeChild(SessionWorkflow, {
      args: [{ spec, runnerId: def.runnerId, title: `${def.title}: ${step.name}` }],
      workflowId: `session-${sessionId}`,
    });
    outcomes.push(out);
    if (out.state !== "done") break;
    previousSessionId = sessionId;
  }
  status.state = outcomes.length === def.steps.length && outcomes.every((o) => o.state === "done") ? "done" : "stopped";
  await cloud.markTask({ taskId: def.taskId, state: status.state, extra: { spendGbp: outcomes.reduce((a, o) => a + o.spendGbp, 0) } });
  return { outcomes };
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
  const tasks = await cloud.tonightTasks({ until });
  for (const t of tasks) if (t.signedGrantIds) signed.set(t.def.taskId, t.signedGrantIds); else status.waitingFor.push(t.def.taskId);

  const limit = input.concurrency ?? 3;
  let running = 0;
  const launched: Promise<unknown>[] = [];
  const launch = async (def: TaskDefinition, grantIds: string[]) => {
    await condition(() => running < limit);
    running++;
    status.started.push(def.taskId);
    const h = await startChild(TaskWorkflow, { args: [{ ...def, grantIds, mode: def.mode ?? "auto" }], workflowId: `task-${def.taskId}`, parentClosePolicy: ParentClosePolicy.ABANDON });
    launched.push(h.result().finally(() => { running--; }));
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

export { workflowInfo, CancellationScope };
