import { ProjectDraft, WorkflowDraft, ProgressAssessment, Lessons } from "@jj/core";
import type { LLM } from "./llm.js";
import { collectFacts, factsToText, type WorkdirFacts } from "./facts.js";
import { mockProjectDraft, mockWorkflowDraft, mockAssessment, mockLessons } from "./mock.js";

export * from "./llm.js";
export * from "./facts.js";

const TOOLS_NOTE = `Tool names the platform understands: Read, Write, Edit, Bash, Glob, Grep, WebFetch for local work; git.push; jira.search, jira.addComment, jira.transition; confluence.getPage; slack.post; gmail.send; notion.createPages; github.pr. Scopes are maps such as {"repo":"owner/name","branch":"feat/*"} or {"channel":"#name"}. Caps are {"count":N} or {"gbp":N}. Outward actions (git.push, slack.post, gmail.send, jira.transition) should never be in the grant template; declare them as intended actions on the step that needs them so the ledger lists them for sign-off.`;

export async function draftProject(workdir: string | undefined, hint: string | undefined, llm?: LLM): Promise<ProjectDraft> {
  const facts = workdir ? await collectFacts(workdir) : undefined;
  if (!llm) return mockProjectDraft(facts, hint);
  const system = `You onboard software and research projects into an agent control plane. Given a folder's facts and the operator's hint, draft the project: a one-line goal the next sessions work towards, 1 to 4 continue steps (each a concrete prompt an autonomous coding agent can act on in that folder), the connectors and skills each step needs, intended actions with scopes and caps, a conservative grant template (read-only and local-only actions only), epics you can infer from docs, commits and TODOs, and risks. Be specific to this codebase; never invent files or tools that are not evidenced. ${TOOLS_NOTE}`;
  const user = [hint ? `Operator hint: ${hint}` : "", facts ? factsToText(facts) : "No folder; a research or planning project."].filter(Boolean).join("\n\n");
  const d = await llm.structured({ system, user, schema: ProjectDraft, schemaName: "project_draft", maxTokens: 6000 });
  if (facts && !d.evidence.length) d.evidence = Object.keys(facts.docs).concat(Object.keys(facts.manifests));
  return d;
}

export async function draftWorkflow(source: { text?: string; path?: string }, llm?: LLM): Promise<WorkflowDraft> {
  let text = source.text ?? "";
  if (source.path) { const { readFile } = await import("node:fs/promises"); text = (await readFile(source.path, "utf8")).slice(0, 30_000); }
  if (!llm) return mockWorkflowDraft(text);
  const system = `You turn written procedures (runbooks, checklists, SOPs, meeting notes, a paragraph of intent) into an executable workflow for an agent control plane: an ordered list of steps, each with a prompt an autonomous agent can act on, the connectors it touches, intended actions with scopes and caps, and a vendor preference where a second-vendor review is sensible. Keep steps coarse (2 to 7). Put review or approval moments as their own step with reviewerOfPrevious. ${TOOLS_NOTE}`;
  return llm.structured({ system, user: text, schema: WorkflowDraft, schemaName: "workflow_draft", maxTokens: 5000 });
}

export interface ProgressInput { projectTitle: string; goal?: string; context: string; recentSummaries: string[]; previous?: unknown; workdirFacts?: WorkdirFacts; memory?: unknown }

/** D1: lessons written by the model from a session summary and its nearest neighbours. */
export async function writeLessons(input: { summary: unknown; neighbours: unknown[]; heuristic: string[] }, llm?: LLM): Promise<Lessons> {
  if (!llm) return mockLessons(input.heuristic);
  const system = `You extract lessons from one agent session for the operator who runs many. A lesson is something that changes what the next session or the operator does: a grant that should be in the template, a prompt that should be more specific, a skill rule, a cost pattern, a process gap. Be concrete, cite the tool or file involved, and do not restate the summary. 0 to 8 lessons, best first.`;
  const user = `Session summary:\n${JSON.stringify(input.summary).slice(0, 6000)}\n\nNearest similar sessions:\n${JSON.stringify(input.neighbours).slice(0, 6000)}\n\nHeuristic observations already made:\n${input.heuristic.join("\n")}`;
  return llm.structured({ system, user, schema: Lessons, schemaName: "lessons", maxTokens: 1500 });
}

export async function assessProgress(input: ProgressInput, llm?: LLM): Promise<ProgressAssessment> {
  if (!llm) return mockAssessment(input);
  const system = `You are the operator's chief of staff for one project. From the continuation context, the most recent session summaries, the previous assessment, the project memory and the current state of the folder, produce an honest progress assessment: status, a one-line headline, what is done, in progress and blocked, the 1 to 5 next steps in priority order, risks, epic statuses, and the exact prompt the next autonomous session should run (specific, scoped to one sitting, referencing files and branches where known). Do not restate completed work as next steps. If sessions keep parking on the same action, say so as a blocker. Also maintain the project memory: add decisions and conventions that are now evidenced, open questions that arose, and list in retire any existing memory line that is no longer true. Memory lines are short, durable facts, not status.`;
  const user = [`Project: ${input.projectTitle}`, input.goal ? `Goal: ${input.goal}` : "", `Context:\n${input.context}`,
    input.recentSummaries.length ? `Recent session summaries (newest first):\n${input.recentSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}` : "No sessions yet.",
    input.previous ? `Previous assessment:\n${JSON.stringify(input.previous).slice(0, 4000)}` : "",
    input.memory ? `Project memory:\n${JSON.stringify(input.memory).slice(0, 3000)}` : "",
    input.workdirFacts ? `Folder now:\n${factsToText({ ...input.workdirFacts, docs: {}, manifests: {} }).slice(0, 4000)}` : ""].filter(Boolean).join("\n\n");
  const a = await llm.structured({ system, user, schema: ProgressAssessment, schemaName: "progress_assessment", maxTokens: 4000 });
  a.assessedAt = new Date().toISOString();
  return a;
}
