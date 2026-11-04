import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { draftProject, draftWorkflow, assessProgress, collectFacts, MockLLM } from "./index.js";
import { ProjectDraft, WorkflowDraft } from "@jj/core";
const run = promisify(execFile);

describe("ingest", () => {
  it("collects facts and drafts a project without an LLM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-ing-"));
    await writeFile(join(dir, "README.md"), "# Metis core\n\nIngest pipeline for the Metis platform.\n\n- [ ] harden ingest\n- [ ] verify cross-platform flow\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "metis-core", scripts: { test: "vitest" } }));
    await mkdir(join(dir, "src")); await writeFile(join(dir, "src", "index.ts"), "export {}");
    await run("git", ["-C", dir, "init", "-q"]); await run("git", ["-C", dir, "add", "-A"]); await run("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=t", "commit", "-qm", "init"]);
    const f = await collectFacts(dir);
    expect(f.isRepo).toBe(true); expect(Object.keys(f.docs)).toContain("README.md"); expect(f.tree).toContain("src/");
    const d = await draftProject(dir, undefined);
    expect(ProjectDraft.parse(d)).toBeTruthy();
    expect(d.goal).toContain("Ingest pipeline");
    expect(d.epics.map((e) => e.title)).toEqual(["harden ingest", "verify cross-platform flow"]);
    expect(d.continueSteps.length).toBe(3);
    expect(d.grantTemplate.every((g) => !/push|post|send/.test(g.action))).toBe(true);
  });
  it("drafts a workflow from a numbered runbook", async () => {
    const d = await draftWorkflow({ text: "# Monday triage\n1. Pull open Sentinel alerts\n2. Match each to a Jira ticket\n3. Draft a findings comment\n4. Post the comment and update status" });
    expect(WorkflowDraft.parse(d).steps.length).toBe(4);
    expect(d.title).toBe("Monday triage");
  });
  it("uses a structured LLM when given one", async () => {
    const llm = new MockLLM((name) => name === "project_draft" ? { title: "x", goal: "g", summary: "s", continueSteps: [{ name: "a", prompt: "p" }] } : {});
    const d = await draftProject(undefined, "hint", llm);
    expect(d.title).toBe("x"); expect(d.continueSteps[0].maxCostGbp).toBe(2);
  });
  it("assesses progress", async () => {
    const a = await assessProgress({ projectTitle: "p", goal: "g", context: "## Still waiting on approval\n- x", recentSummaries: ["did a thing"] });
    expect(a.status).toBe("blocked"); expect(a.suggestedPrompt).toContain("Continue p");
  });
});
