import { Connection, Client } from "@temporalio/client";
import { TaskWorkflow, SessionWorkflow, IndexWorkflow, NightlyLearnWorkflow, OvernightBatchWorkflow, ChoreRunWorkflow, ProgressWorkflow, IngestProjectWorkflow, IngestWorkflowWorkflow } from "./workflows.js";
import { CLOUD_QUEUE, type TaskDefinition, approveSignal, cancelSignal, continueSignal, pauseSignal, nudgeSignal, ledgerSignedSignal, statusQuery, taskStatusQuery, batchStatusQuery } from "./shared.js";

export async function temporalClient() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
}

export async function startTask(client: Client, def: TaskDefinition) {
  return client.workflow.start(TaskWorkflow, { args: [def], taskQueue: CLOUD_QUEUE, workflowId: `task-${def.taskId}` });
}

export async function approve(client: Client, sessionId: string, callId: string, mode: "once" | "widen" | "deny", grantIds?: string[]) {
  await client.workflow.getHandle(`session-${sessionId}`).signal(approveSignal, callId, mode, grantIds);
}
export async function goAhead(client: Client, taskId: string, stepIndex: number, go: boolean) {
  await client.workflow.getHandle(`task-${taskId}`).signal(continueSignal, stepIndex, go);
}
export async function pauseTask(client: Client, taskId: string, paused: boolean) {
  await client.workflow.getHandle(`task-${taskId}`).signal(pauseSignal, paused);
}
export async function nudge(client: Client, sessionId: string, text: string, final?: boolean) {
  await client.workflow.getHandle(`session-${sessionId}`).signal(nudgeSignal, text, final);
}
export async function taskStatus(client: Client, taskId: string) {
  return client.workflow.getHandle(`task-${taskId}`).query(taskStatusQuery);
}
export async function cancel(client: Client, sessionId: string, reason: string) {
  await client.workflow.getHandle(`session-${sessionId}`).signal(cancelSignal, reason);
}
export async function status(client: Client, sessionId: string) {
  return client.workflow.getHandle(`session-${sessionId}`).query(statusQuery);
}
export async function startOvernightBatch(client: Client, until: string, opts: { signDeadlineMinutes?: number; concurrency?: number } = {}) {
  const id = `overnight-${until.slice(0, 10)}`;
  return client.workflow.start(OvernightBatchWorkflow, { args: [{ until, ...opts }], taskQueue: CLOUD_QUEUE, workflowId: id, workflowIdReusePolicy: 3 /* TERMINATE_IF_RUNNING */ as any });
}
export async function notifyLedgerSigned(client: Client, taskId: string, grantIds: string[]) {
  const open = client.workflow.list({ query: `WorkflowType = 'OvernightBatchWorkflow' AND ExecutionStatus = 'Running'` });
  for await (const wf of open) await client.workflow.getHandle(wf.workflowId).signal(ledgerSignedSignal, taskId, grantIds).catch(() => undefined);
}
export async function batchStatus(client: Client, workflowId: string) { return client.workflow.getHandle(workflowId).query(batchStatusQuery); }
export async function ingestProject(client: Client, input: { workdir?: string; hint?: string; runnerId: string }) {
  const h = await client.workflow.start(IngestProjectWorkflow, { args: [input], taskQueue: CLOUD_QUEUE, workflowId: `ingest-project-${Date.now()}` });
  return h.result();
}
export async function ingestWorkflow(client: Client, input: { text?: string; path?: string; runnerId: string }) {
  const h = await client.workflow.start(IngestWorkflowWorkflow, { args: [input], taskQueue: CLOUD_QUEUE, workflowId: `ingest-workflow-${Date.now()}` });
  return h.result();
}
export async function assessProject(client: Client, projectId: string) {
  const h = await client.workflow.start(ProgressWorkflow, { args: [{ projectId }], taskQueue: CLOUD_QUEUE, workflowId: `progress-${projectId}-manual-${Date.now()}` });
  return h.result();
}
export { SessionWorkflow, TaskWorkflow, IndexWorkflow, NightlyLearnWorkflow, OvernightBatchWorkflow, ChoreRunWorkflow, ProgressWorkflow, IngestProjectWorkflow, IngestWorkflowWorkflow };
