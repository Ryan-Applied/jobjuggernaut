/**
 * Activity *interfaces*. Implementations live where the side effects live:
 *  - local activities in apps/runner-daemon (startSession, pumpEvents, cancelSession)
 *  - cloud activities in apps/indexer and apps/api (writeEvents, recordOutcome)
 * Temporal routes by task queue, so one workflow calls both sets.
 */
import type { SessionEvent, SessionSpec, RunnerCapabilities } from "@jj/core";

export interface LocalActivities {
  describeRunner(): Promise<RunnerCapabilities>;
  startSession(spec: SessionSpec): Promise<{ vendorSessionRef: string }>;
  /** Pumps events from the runner's stream to the API in batches, returning when the session ends or parks. Heartbeats lastSeq. */
  pumpEvents(input: { sessionId: string; fromSeq: number }): Promise<{ lastSeq: number; ended: boolean; parkedCallId?: string; parkedGap?: string; spendGbp: number; outcome?: string }>;
  resumeSession(input: { sessionId: string; callId: string; approved: boolean }): Promise<void>;
  cancelSession(input: { sessionId: string; reason: string }): Promise<void>;
}

export interface CloudActivities {
  createSessionNode(input: { sessionId: string; title: string; props: Record<string, unknown> }): Promise<void>;
  linkSessionToWorkflow(input: { sessionId: string; workflowId: string; taskId: string }): Promise<void>;
  recordOutcome(input: { sessionId: string; outcome: string; spendGbp: number }): Promise<void>;
  postSlackCard(input: { sessionId: string; callId: string; gap: string }): Promise<void>;
  startIndexing(input: { sessionId: string }): Promise<void>;
}

export interface IndexerActivities {
  indexSession(input: { sessionId: string }): Promise<{ similar: number; edges: number; lessons: number }>;
  proposeForWorkflow(input: { workflowId: string }): Promise<{ proposals: number }>;
  listWorkflowIds(): Promise<string[]>;
}

export type Activities = LocalActivities & CloudActivities & IndexerActivities;
export type { SessionEvent };
