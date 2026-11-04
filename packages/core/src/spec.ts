import { z } from "zod";
import { Vendor } from "./events.js";

export const Mode = z.enum(["auto", "assist", "manual"]);
export type Mode = z.infer<typeof Mode>;

export const SessionSpec = z.object({
  sessionId: z.string().uuid(),
  workflowId: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
  mode: Mode.default("assist"),
  stepIndex: z.number().int().nonnegative().default(0),
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).default([]),
  connectors: z.array(z.string()).default([]),
  grantIds: z.array(z.string().uuid()).default([]),
  workdir: z.string(),
  /** Project workdir on the runner host. Repo => worktree per session; folder => in place; absent => scratch. */
  projectWorkdir: z.string().optional(),
  isolation: z.enum(["worktree", "inplace", "scratch", "container"]).optional(),
  /** Continuation pack: what the session should know before it starts. Prepended to the prompt. */
  context: z.string().optional(),
  budget: z.object({
    maxTokens: z.number().int().positive().optional(),
    maxCostGbp: z.number().positive(),
    deadline: z.string().datetime().optional(),
  }),
  requires: z.array(z.string()).default([]),
  preferredVendor: Vendor.optional(),
  reviewerOf: z.string().uuid().optional(),
  /** Vendor to avoid (reviewer must differ from author). */
  avoidVendor: Vendor.optional(),
  /** Keep the session open for follow-up input after the first turn (B1). Idle timeout in minutes. */
  interactive: z.boolean().optional(),
  idleMinutes: z.number().int().positive().optional(),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

export const RunnerCapabilities = z.object({
  runnerId: z.string(),
  vendor: Vendor,
  tools: z.array(z.string()),
  maxContextTokens: z.number().int().positive(),
  supportsResume: z.boolean(),
  supportsSubagents: z.boolean(),
  costModel: z.object({
    inputPer1k: z.number().nonnegative(),
    outputPer1k: z.number().nonnegative(),
    currency: z.literal("GBP"),
  }),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

export const SessionInput = z.object({ text: z.string(), /** End the session after this turn completes. */ final: z.boolean().optional() });
export type SessionInput = z.infer<typeof SessionInput>;

// ---- LLM-assisted ingestion and progress ---------------------------------------------
const Scope = z.record(z.union([z.string(), z.array(z.string())]));
const Cap = z.object({ count: z.number().int().positive().optional(), gbp: z.number().positive().optional() });
export const IntendedAction = z.object({ tool: z.string(), scope: Scope.default({}), cap: Cap.default({}) });
export const StepDraft = z.object({
  name: z.string(), prompt: z.string(),
  skills: z.array(z.string()).default([]), connectors: z.array(z.string()).default([]),
  preferredVendor: Vendor.optional(), reviewerOfPrevious: z.boolean().optional(),
  intendedActions: z.array(IntendedAction).default([]), maxCostGbp: z.number().positive().default(2),
  /** C1: run after these steps (by name). Steps with no `after` run in the first wave. */
  after: z.array(z.string()).optional(),
  /** C2: retries on failure, and what to do when retries are exhausted. */
  retry: z.number().int().min(0).max(5).optional(),
  onFailure: z.string().optional(),            // "stop" (default) | "continue" | "run:<stepName>"
});
export const ProjectDraft = z.object({
  title: z.string(),
  goal: z.string(),
  summary: z.string(),                          // what the LLM understood the project to be
  defaultMode: Mode.default("assist"),
  continueSteps: z.array(StepDraft).min(1),
  grantTemplate: z.array(z.object({ action: z.string(), scope: Scope.default({}), cap: Cap.default({}) })).default([]),
  skills: z.array(z.string()).default([]),
  connectors: z.array(z.string()).default([]),
  suggestedChore: z.object({ cron: z.string(), mode: Mode, reason: z.string() }).optional(),
  epics: z.array(z.object({ title: z.string(), status: z.enum(["todo", "in_progress", "done"]).default("todo"), notes: z.string().optional() })).default([]),
  risks: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),    // files/facts the draft was based on
});
export type ProjectDraft = z.infer<typeof ProjectDraft>;

export const WorkflowDraft = z.object({
  title: z.string(), description: z.string().optional(),
  steps: z.array(StepDraft).min(1),
  grantTemplate: z.array(z.object({ action: z.string(), scope: Scope.default({}), cap: Cap.default({}) })).default([]),
  suggestedChore: z.object({ cron: z.string(), mode: Mode, reason: z.string() }).optional(),
  evidence: z.array(z.string()).default([]),
});
export type WorkflowDraft = z.infer<typeof WorkflowDraft>;

export const ProgressAssessment = z.object({
  status: z.enum(["on_track", "at_risk", "blocked", "done", "unknown"]),
  headline: z.string(),                          // one line for the Today card
  percent: z.number().min(0).max(100).optional(),
  done: z.array(z.string()).default([]),
  inProgress: z.array(z.string()).default([]),
  blocked: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
  suggestedPrompt: z.string(),                   // what Continue should run next
  risks: z.array(z.string()).default([]),
  epics: z.array(z.object({ title: z.string(), status: z.enum(["todo", "in_progress", "done"]), notes: z.string().optional() })).default([]),
  /** D6: durable project memory the LLM maintains across sessions. Merged, not replaced. */
  memory: z.object({
    decisions: z.array(z.string()).default([]),      // "We use pnpm, not npm"
    conventions: z.array(z.string()).default([]),    // "Branches are jj/<topic>"
    openQuestions: z.array(z.string()).default([]),
    retire: z.array(z.string()).default([]),         // memory lines that are no longer true
  }).optional(),
  assessedAt: z.string().datetime().optional(),
});
export type ProgressAssessment = z.infer<typeof ProgressAssessment>;

export const Lessons = z.object({
  lessons: z.array(z.object({ text: z.string(), kind: z.enum(["grant", "prompt", "skill", "cost", "process", "other"]).default("other"), confidence: z.number().min(0).max(1).default(0.7) })).max(8),
});
export type Lessons = z.infer<typeof Lessons>;

