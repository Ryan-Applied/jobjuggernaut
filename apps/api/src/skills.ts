/**
 * Skills live in a git repo (SKILLS_DIR, default ./skills in this repo).
 * Accepting a skill_edit proposal appends a dated "Lessons" section to the skill's
 * SKILL.md, bumps the version in the graph, and commits on a branch skill/<id>-v<N>
 * so you review it like any other change. If the dir is not a git repo the file is
 * written in place and that is reported.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export const SKILLS_DIR = process.env.SKILLS_DIR ?? resolve(process.cwd(), "../../skills");

export async function applySkillLessons(skillId: string, lessons: string[], version: number): Promise<{ path: string; branch?: string; committed: boolean; prUrl?: string }> {
  const path = resolve(SKILLS_DIR, skillId, "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  let body = await readFile(path, "utf8").catch(() => `---\nname: ${skillId}\ndescription: ${skillId}\n---\n\n`);
  const date = new Date().toISOString().slice(0, 10);
  body = body.trimEnd() + `\n\n## Lessons (v${version}, ${date})\n\n` + lessons.map((l) => `- ${l}`).join("\n") + "\n";
  await writeFile(path, body);
  const repo = await findRepo(SKILLS_DIR);
  if (!repo) return { path, committed: false };
  const branch = `skill/${skillId}-v${version}`;
  const g = (...a: string[]) => run("git", ["-C", repo, ...a]);
  const current = (await g("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
  try {
    await g("checkout", "-B", branch);
    await g("add", path);
    await g("-c", "user.email=jobjuggernaut@local", "-c", "user.name=jobjuggernaut", "commit", "-m", `skill(${skillId}): v${version} lessons from the nightly learn pass`);
    let prUrl: string | undefined;
    if (process.env.SKILLS_PR === "1") {
      await g("push", "-u", "origin", branch).catch(() => undefined);
      const body = `Lessons folded into ${skillId} v${version}:\n\n` + lessons.map((l) => `- ${l}`).join("\n");
      prUrl = await run("gh", ["pr", "create", "--head", branch, "--title", `skill(${skillId}): v${version}`, "--body", body], { cwd: repo }).then((r) => r.stdout.trim().split("\n").pop()).catch(() => undefined);
    }
    return { path, branch, committed: true, prUrl };
  } finally { await g("checkout", current).catch(() => undefined); }
}

async function findRepo(dir: string): Promise<string | undefined> {
  return run("git", ["-C", dir, "rev-parse", "--show-toplevel"]).then((r) => r.stdout.trim()).catch(() => undefined);
}
