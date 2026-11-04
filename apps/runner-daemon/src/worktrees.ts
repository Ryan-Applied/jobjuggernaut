import { mkdir, stat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

/**
 * One isolated directory per session. If a repo is named, create a git worktree
 * off a fresh branch; otherwise a plain scratch directory.
 */
export class WorktreeManager {
  constructor(private root = process.env.WORKTREE_ROOT ?? "./.worktrees") {}

  /**
   * Repo => git worktree on jj/<id>; folder => used in place; nothing => scratch dir.
   * `isolation` overrides the default.
   */
  async prepare(sessionId: string, projectWorkdir?: string, isolation?: "worktree" | "inplace" | "scratch" | "container"): Promise<{ dir: string; isolation: string; branch?: string }> {
    const scratch = resolve(this.root, sessionId);
    await mkdir(resolve(this.root), { recursive: true });
    if (!projectWorkdir || isolation === "scratch") { await mkdir(scratch, { recursive: true }); return { dir: scratch, isolation: "scratch" }; }
    const isRepo = await this.isRepo(projectWorkdir);
    if (isolation === "inplace" || !isRepo) return { dir: projectWorkdir, isolation: "inplace" };
    const branch = `jj/${sessionId.slice(0, 8)}`;
    await run("git", ["-C", projectWorkdir, "worktree", "add", "-b", branch, scratch]).catch(async (e) => {
      if (!String(e).includes("already exists")) throw e;
    });
    // "container" keeps the worktree on disk and runs shell tools inside a sandbox (adapter-dependent).
    return { dir: scratch, isolation: isolation === "container" ? "container" : "worktree", branch };
  }

  /** B6: after a session ends. Clean worktrees with no unique commits; keep the rest (and always keep the branch). */
  async release(sessionId: string, projectWorkdir: string | undefined, outcome: string): Promise<{ kept: boolean; reason: string; branch?: string }> {
    const dir = resolve(this.root, sessionId);
    if (!projectWorkdir || !(await this.isRepo(projectWorkdir))) return { kept: true, reason: "not a worktree" };
    const g = (...a: string[]) => run("git", ["-C", dir, ...a]).then((r) => r.stdout.trim()).catch(() => "");
    const branch = await g("rev-parse", "--abbrev-ref", "HEAD");
    const dirty = await g("status", "--porcelain");
    const ahead = await g("rev-list", "--count", `HEAD@{upstream}..HEAD`).catch(() => "") || await g("rev-list", "--count", "main..HEAD").catch(() => "") || "0";
    if (dirty) return { kept: true, reason: "uncommitted changes", branch };
    if (Number(ahead) > 0) return { kept: true, reason: `${ahead} commits on ${branch}`, branch };
    if (outcome !== "complete") return { kept: true, reason: `outcome ${outcome}`, branch };
    await run("git", ["-C", projectWorkdir, "worktree", "remove", "--force", dir]).catch(() => undefined);
    await run("git", ["-C", projectWorkdir, "branch", "-D", branch]).catch(() => undefined);
    return { kept: false, reason: "no changes", branch };
  }

  async isRepo(dir: string) { return run("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]).then(() => true).catch(() => false); }

  async inspect(dir: string) {
    const isRepo = await this.isRepo(dir);
    const hasClaudeMd = await stat(resolve(dir, "CLAUDE.md")).then(() => true).catch(() => false);
    if (!isRepo) { const files = await readdir(dir).catch(() => []); return { isRepo, hasClaudeMd, files: files.length }; }
    const g = (args: string[]) => run("git", ["-C", dir, ...args]).then((r) => r.stdout.trim()).catch(() => "");
    const [branch, status, log, branches] = await Promise.all([g(["rev-parse", "--abbrev-ref", "HEAD"]), g(["status", "--porcelain"]), g(["log", "--oneline", "-8"]), g(["branch", "--format=%(refname:short)", "--sort=-committerdate"])]);
    return { isRepo, hasClaudeMd, branch, dirty: status ? status.split("\n").length : 0, recentCommits: log ? log.split("\n") : [], openBranches: branches ? branches.split("\n").slice(0, 8) : [] };
  }


}
