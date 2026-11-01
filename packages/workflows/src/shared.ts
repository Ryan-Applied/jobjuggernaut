import { defineSignal, defineQuery } from "@temporalio/workflow";

export const CLOUD_QUEUE = "cloud";
export const localQueue = (runnerId: string) => `local-${runnerId}`;

export type ApprovalMode = "once" | "widen" | "deny";
export const approveSignal = defineSignal<[callId: string, mode: ApprovalMode]>("approve");
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
  title: string;
  steps: TaskStep[];
  grantIds: string[];
  runnerId: string;
}
