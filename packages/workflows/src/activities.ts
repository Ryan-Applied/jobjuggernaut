/**
 * Activity *interfaces*. Implementations live where the side effects live:
 *  - local activities in apps/runner-daemon (startSession, pumpEvents, cancelSession)
 *  - cloud activities in apps/indexer and apps/api (writeEvents, recordOutcome)
 * Temporal routes by task queue, so one workflow calls both sets.
 */
import type { SessionEvent, SessionSpec, RunnerCapabilities, ProjectDraft, WorkflowDraft, ProgressAssessment } from "@jj/core";

export interface LocalActivities {
  describeRunner(): Promise<RunnerCapabilities>;
  startSession(spec: SessionSpec): Promise<{ vendorSessionRef: string }>;
  /** Pumps events from the runner's stream to the API in batches, returning when the session ends or parks. Heartbeats lastSeq. */
  pumpEvents(input: { sessionId: string; fromSeq: number }): Promise<{ lastSeq: number; ended: boolean; parkedCallId?: string; parkedGap?: string; spendGbp: number; outcome?: string }>;
  resumeSession(input: { sessionId: string; callId: string; approved: boolean; grantIds?: string[] }): Promise<void>;
  /** LLM-assisted, run where the files and the vendor key live. */
  draftProject(input: { workdir?: string; hint?: string }): Promise<ProjectDraft>;
  draftWorkflow(input: { text?: string; path?: string }): Promise<WorkflowDraft>;
  assessProgress(input: { projectTitle: string; goal?: string; context: string; recentSummaries: string[]; previous?: unknown; workdir?: string }): Promise<ProgressAssessment>;
  /** Read-only look at a project workdir for the continuation pack. */
  inspectWorkdir(input: { workdir: string }): Promise<{ isRepo: boolean; branch?: string; dirty?: number; recentCommits?: string[]; openBranches?: string[]; hasClaudeMd?: boolean; files?: number }>;
  cancelSession(input: { sessionId: string; reason: string }): Promise<void>;
}

export interface CloudActivities {
  createSessionNode(input: { sessionId: string; title: string; props: Record<string, unknown> }): Promise<void>;
  linkSessionToWorkflow(input: { sessionId: string; workflowId: string; taskId: string }): Promise<void>;
  recordOutcome(input: { sessionId: string; outcome: string; spendGbp: number }): Promise<void>;
  postSlackCard(input: { sessionId: string; callId: string; gap: string }): Promise<void>;
  startIndexing(input: { sessionId: string }): Promise<void>;
  /** Graph side of the continuation pack: recent sessions, lessons, open items for a project. */
  projectContext(input: { projectId: string }): Promise<string>;
  markTask(input: { taskId: string; state: string; extra?: Record<string, unknown> }): Promise<void>;
  /** Tasks queued for tonight with their ledger status. */
  tonightTasks(input: { until: string }): Promise<Array<{ def: TaskDefinition; signedGrantIds?: string[] }>>;
  /** Progress inputs for a project and where to store the result. */
  progressInputs(input: { projectId: string }): Promise<{ projectTitle: string; goal?: string; context: string; recentSummaries: string[]; previous?: unknown; workdir?: string; runnerId: string } | undefined>;
  storeProgress(input: { projectId: string; assessment: ProgressAssessment }): Promise<void>;
  sessionProject(input: { sessionId: string }): Promise<{ projectId?: string }>;
  /** Chore fire: create a task node + ledger from the chore's template; returns the definition to run. */
  materialiseChore(input: { choreId: string }): Promise<{ def: TaskDefinition } | { skipped: string }>;
}
import type { TaskDefinition } from "./shared.js";

export interface IndexerActivities {
  indexSession(input: { sessionId: string }): Promise<{ similar: number; edges: number; lessons: number }>;
  proposeForWorkflow(input: { workflowId: string }): Promise<{ proposals: number }>;
  listWorkflowIds(): Promise<string[]>;
}

export type Activities = LocalActivities & CloudActivities & IndexerActivities;
export type { SessionEvent };
