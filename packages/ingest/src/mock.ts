/** Deterministic drafts from facts alone. Used in tests and under JJ_MOCK_RUNNER. */
import type { ProjectDraft, WorkflowDraft, ProgressAssessment } from "@jj/core";
import type { WorkdirFacts } from "./facts.js";
import type { ProgressInput } from "./index.js";

export function mockProjectDraft(f?: WorkdirFacts, hint?: string): ProjectDraft {
  const name = f ? f.path.split("/").filter(Boolean).pop()! : (hint?.split(/\s+/).slice(0, 3).join("-") ?? "project");
  const lang = f?.manifests["package.json"] ? "node" : f?.manifests["pyproject.toml"] || f?.manifests["requirements.txt"] ? "python" : f?.manifests["go.mod"] ? "go" : "unknown";
  const readme = f?.docs["README.md"] ?? f?.docs["readme.md"] ?? "";
  const firstLine = readme.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim();
  const todos = Object.values(f?.docs ?? {}).join("\n").split("\n").filter((l) => /^\s*[-*]\s*\[ \]/.test(l)).slice(0, 5).map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, ""));
  return {
    title: name, goal: hint ?? firstLine ?? `Keep ${name} moving: fix failing checks, then work the TODO list.`,
    summary: `${lang} project at ${f?.path ?? "no folder"}; ${f?.totalFiles ?? 0} files; ${f?.recentCommits.length ?? 0} recent commits seen.`,
    defaultMode: "assist",
    continueSteps: [
      { name: "orient", prompt: `Read README.md and CLAUDE.md if present, run the test suite, and list what is failing or missing against the goal.`, skills: [], connectors: [], intendedActions: [{ tool: "Read", scope: {}, cap: { count: 50 } }, { tool: "Bash", scope: {}, cap: { count: 20 } }], maxCostGbp: 1 },
      { name: "implement", prompt: `Implement the highest-value item from the orient step on a branch named jj/<short-topic>, with tests. Commit with a clear message. Do not push.`, skills: [], connectors: [], intendedActions: [{ tool: "Write", scope: {}, cap: { count: 40 } }, { tool: "Bash", scope: {}, cap: { count: 40 } }], maxCostGbp: 3 },
      { name: "review", prompt: "Review the diff on the branch for defects, gaps and style. Report, do not edit.", skills: ["review-findings"], connectors: [], preferredVendor: "gemini", reviewerOfPrevious: true, intendedActions: [{ tool: "Read", scope: {}, cap: { count: 50 } }], maxCostGbp: 0.5 },
    ],
    grantTemplate: [{ action: "Read", scope: {}, cap: { count: 100 } }, { action: "Glob", scope: {}, cap: { count: 50 } }, { action: "Grep", scope: {}, cap: { count: 50 } }],
    skills: ["review-findings"], connectors: [],
    suggestedChore: f?.isRepo ? { cron: "30 7 * * 1-5", mode: "assist", reason: "Daily orient-and-implement pass on weekday mornings." } : undefined,
    epics: todos.map((t) => ({ title: t, status: "todo" as const })),
    risks: f?.isRepo && f.branches.length > 6 ? ["Many open branches; agree which is the integration branch."] : [],
    evidence: Object.keys(f?.docs ?? {}).concat(Object.keys(f?.manifests ?? {})),
  };
}

export function mockWorkflowDraft(text: string): WorkflowDraft {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /^(\d+[.)]|[-*])\s+/.test(l)).map((l) => l.replace(/^(\d+[.)]|[-*])\s+/, "")).slice(0, 7);
  const steps = (lines.length ? lines : [text.slice(0, 200) || "Do the thing"]).map((l, i) => ({ name: `step ${i + 1}`, prompt: l, skills: [], connectors: [], intendedActions: [{ tool: "Read", scope: {}, cap: { count: 20 } }], maxCostGbp: 1 }));
  return { title: text.split("\n")[0].replace(/^#+\s*/, "").slice(0, 60) || "Workflow", steps, grantTemplate: [{ action: "Read", scope: {}, cap: { count: 50 } }], evidence: ["text"] };
}

export function mockAssessment(i: ProgressInput): ProgressAssessment {
  const n = i.recentSummaries.length;
  const blocked = i.context.includes("Still waiting on approval") ? ["A session is parked waiting for approval."] : [];
  return {
    status: blocked.length ? "blocked" : n === 0 ? "unknown" : "on_track",
    headline: n === 0 ? "No sessions yet; start with an orient pass." : `${n} recent session${n > 1 ? "s" : ""}; last: ${i.recentSummaries[0].slice(0, 80)}`,
    percent: Math.min(90, n * 15),
    done: i.recentSummaries.slice(1).map((s) => s.slice(0, 60)), inProgress: n ? [i.recentSummaries[0].slice(0, 60)] : [], blocked,
    nextSteps: ["Run the tests and fix the first failure", "Pick the next epic", "Open a PR for review"],
    suggestedPrompt: `Continue ${i.projectTitle}: ${i.goal ?? "work the goal"}. Start by running the tests; fix the first failure; commit on the current jj/ branch.`,
    risks: [], epics: [], assessedAt: new Date().toISOString(),
  };
}
