import { proxyActivities, setHandler, condition, workflowInfo, executeChild, CancellationScope, isCancellation, uuid4 } from "@temporalio/workflow";
import type { LocalActivities, CloudActivities } from "./activities.js";
import { approveSignal, cancelSignal, statusQuery, CLOUD_QUEUE, localQueue, type SessionStatus, type TaskDefinition, type ApprovalMode } from "./shared.js";
import type { SessionSpec } from "@jj/core";

const cloud = proxyActivities<CloudActivities>({
  taskQueue: CLOUD_QUEUE,
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 5 },
});

function localFor(runnerId: string) {
  return proxyActivities<LocalActivities>({
    taskQueue: localQueue(runnerId),
    startToCloseTimeout: "4 hours",
    heartbeatTimeout: "30 seconds",
    retry: { maximumAttempts: 3, initialInterval: "10 seconds" },
  });
}

export interface SessionWorkflowInput { spec: SessionSpec; runnerId: string; title: string }

/**
 * One agent session, end to end. Survives the runner daemon restarting:
 * pumpEvents resumes from lastSeq. Parks on approval_request and waits for the approve signal.
 */
export async function SessionWorkflow(input: SessionWorkflowInput): Promise<SessionStatus> {
  const local = localFor(input.runnerId);
  const status: SessionStatus = { state: "starting", lastSeq: -1, spendGbp: 0 };
  let decision: { callId: string; mode: ApprovalMode } | undefined;
  let cancelReason: string | undefined;

  setHandler(statusQuery, () => status);
  setHandler(approveSignal, (callId, mode) => { decision = { callId, mode }; });
  setHandler(cancelSignal, (reason) => { cancelReason = reason; });

  await cloud.createSessionNode({ sessionId: input.spec.sessionId, title: input.title, props: { state: "starting", runnerId: input.runnerId, workflowId: input.spec.workflowId, taskId: input.spec.taskId } });
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
      const r = await local.pumpEvents({ sessionId: input.spec.sessionId, fromSeq: status.lastSeq + 1 });
      status.lastSeq = r.lastSeq; status.spendGbp = r.spendGbp;
      if (r.ended) { status.state = "done"; status.outcome = r.outcome; break; }
      if (r.parkedCallId) {
        status.state = "parked"; status.parkedCallId = r.parkedCallId; status.parkedGap = r.parkedGap;
        await cloud.postSlackCard({ sessionId: input.spec.sessionId, callId: r.parkedCallId, gap: r.parkedGap ?? "" });
        await condition(() => decision?.callId === r.parkedCallId || !!cancelReason);
        if (cancelReason) continue;
        const approved = decision!.mode !== "deny";
        decision = undefined;
        await local.resumeSession({ sessionId: input.spec.sessionId, callId: r.parkedCallId, approved });
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

/** Runs a task's steps in order, each as a child SessionWorkflow. */
export async function TaskWorkflow(def: TaskDefinition): Promise<{ outcomes: SessionStatus[] }> {
  const outcomes: SessionStatus[] = [];
  let previousSessionId: string | undefined;
  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    const sessionId = uuid4();
    const spec: SessionSpec = {
      sessionId, workflowId: def.workflowId, taskId: def.taskId, stepIndex: i,
      prompt: step.prompt, skills: step.skills ?? [], connectors: step.connectors ?? [],
      grantIds: def.grantIds, workdir: `${def.taskId}/${i}`,
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
  return { outcomes };
}

export { workflowInfo, CancellationScope };
