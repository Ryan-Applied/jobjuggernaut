import { Connection, Client } from "@temporalio/client";
import { TaskWorkflow, SessionWorkflow, IndexWorkflow, NightlyLearnWorkflow } from "./workflows.js";
import { CLOUD_QUEUE, type TaskDefinition, approveSignal, cancelSignal, statusQuery } from "./shared.js";

export async function temporalClient() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
}

export async function startTask(client: Client, def: TaskDefinition) {
  return client.workflow.start(TaskWorkflow, { args: [def], taskQueue: CLOUD_QUEUE, workflowId: `task-${def.taskId}` });
}

export async function approve(client: Client, sessionId: string, callId: string, mode: "once" | "widen" | "deny") {
  await client.workflow.getHandle(`session-${sessionId}`).signal(approveSignal, callId, mode);
}
export async function cancel(client: Client, sessionId: string, reason: string) {
  await client.workflow.getHandle(`session-${sessionId}`).signal(cancelSignal, reason);
}
export async function status(client: Client, sessionId: string) {
  return client.workflow.getHandle(`session-${sessionId}`).query(statusQuery);
}
export { SessionWorkflow, TaskWorkflow, IndexWorkflow, NightlyLearnWorkflow };
