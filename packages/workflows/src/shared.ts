import { defineSignal, defineQuery } from "@temporalio/workflow";

export const CLOUD_QUEUE = "cloud";
export const INDEXER_QUEUE = "indexer";
export const localQueue = (runnerId: string) => `local-${runnerId}`;

export type ApprovalMode = "once" | "widen" | "deny";
export const approveSignal = defineSignal<[callId: string, mode: ApprovalMode, grantIds?: string[]]>("approve");
/** Assist mode: go-ahead between steps. */
export const continueSignal = defineSignal<[stepIndex: number, go: boolean]>("continue");
export const taskStatusQuery = defineQuery<TaskStatus>("taskStatus");
export interface TaskStatus { stepIndex: number; state: "running" | "awaiting_go_ahead" | "done" | "stopped"; sessionIds: string[] }
export const cancelSignal = defineSignal<[reason: string]>("cancel");
export const statusQuery = defineQuery<SessionStatus>("status");

export interface SessionStatus {
  state: "starting" | "running" | "parked" | "done" | "cancelled" | "error";
  lastSeq: number;
  parkedCallId?: string;
  parkedGap?: string;
  spendGbp: number;
  outcome?: string;
  restarts: number;
}

export interface TaskStep {
  name: string;
  prompt: string;
  skills?: string[];
  connectors?: string[];
  requires?: string[];
  preferredVendor?: "claude" | "openai" | "gemini";
  reviewerOfPrevious?: boolean;
  maxCostGbp: number;
}

export interface TaskDefinition {
  taskId: string;
  workflowId: string;
  projectId?: string;
  title: string;
  steps: TaskStep[];
  grantIds: string[];
  runnerId: string;
  mode?: "auto" | "assist" | "manual";
  projectWorkdir?: string;
  /** Continuation pack text; the API builds it from the graph and the runner's workdir inspection. */
  context?: string;
}

export const ledgerSignedSignal = defineSignal<[taskId: string, grantIds: string[]]>("ledgerSigned");
export const batchStatusQuery = defineQuery<BatchStatus>("batchStatus");
export interface BatchStatus { started: string[]; skipped: Array<{ taskId: string; reason: string }>; waitingFor: string[]; finishedAt?: string }
