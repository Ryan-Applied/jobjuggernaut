import { defineSignal, defineQuery } from "@temporalio/workflow";

export const CLOUD_QUEUE = "cloud";
export const INDEXER_QUEUE = "indexer";
export const localQueue = (runnerId: string) => `local-${runnerId}`;

export type ApprovalMode = "once" | "widen" | "deny";
export const approveSignal = defineSignal<[callId: string, mode: ApprovalMode, grantIds?: string[]]>("approve");
/** Assist mode: go-ahead between steps. */
export const continueSignal = defineSignal<[stepIndex: number, go: boolean]>("continue");
/** C5: pause/resume between waves. */
export const pauseSignal = defineSignal<[paused: boolean]>("pause");
/** B1: follow-up text into the running session. */
export const nudgeSignal = defineSignal<[text: string, final?: boolean]>("nudge");
export const taskStatusQuery = defineQuery<TaskStatus>("taskStatus");
export interface TaskStatus { stepIndex: number; state: "running" | "awaiting_go_ahead" | "paused" | "done" | "stopped" | "over_budget" | "deadline"; sessionIds: string[]; spendGbp: number; wave: number }
export const cancelSignal = defineSignal<[reason: string]>("cancel");
export const statusQuery = defineQuery<SessionStatus>("status");

export interface SessionStatus {
  state: "starting" | "running" | "parked" | "done" | "cancelled" | "error";
  vendor?: string;
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
  /** C1 */ after?: string[];
  /** C2 */ retry?: number; onFailure?: string;
  /** B1 */ interactive?: boolean; idleMinutes?: number;
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
  /** C3 */ budgetGbp?: number; deadline?: string;
  /** C6 */ priority?: number; runnerAffinity?: "fixed" | "any";
}

export const ledgerSignedSignal = defineSignal<[taskId: string, grantIds: string[]]>("ledgerSigned");
export const batchStatusQuery = defineQuery<BatchStatus>("batchStatus");
export interface BatchStatus { started: string[]; skipped: Array<{ taskId: string; reason: string }>; waitingFor: string[]; finishedAt?: string }
