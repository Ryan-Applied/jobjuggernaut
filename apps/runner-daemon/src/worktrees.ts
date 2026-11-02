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
  async prepare(sessionId: string, projectWorkdir?: string, isolation?: "worktree" | "inplace" | "scratch"): Promise<{ dir: string; isolation: string }> {
    const scratch = resolve(this.root, sessionId);
    await mkdir(resolve(this.root), { recursive: true });
    if (!projectWorkdir || isolation === "scratch") { await mkdir(scratch, { recursive: true }); return { dir: scratch, isolation: "scratch" }; }
    const isRepo = await this.isRepo(projectWorkdir);
    if (isolation === "inplace" || !isRepo) return { dir: projectWorkdir, isolation: "inplace" };
    await run("git", ["-C", projectWorkdir, "worktree", "add", "-b", `jj/${sessionId.slice(0, 8)}`, scratch]).catch(async (e) => {
      if (!String(e).includes("already exists")) throw e;
    });
    return { dir: scratch, isolation: "worktree" };
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

  async release(sessionId: string, repoPath?: string) {
    const dir = resolve(this.root, sessionId);
    if (repoPath) await run("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => undefined);
  }
}
