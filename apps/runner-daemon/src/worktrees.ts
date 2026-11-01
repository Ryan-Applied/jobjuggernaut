import { mkdir } from "node:fs/promises";
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

  async prepare(sessionId: string, repoPath?: string, branch?: string): Promise<string> {
    const dir = resolve(this.root, sessionId);
    await mkdir(resolve(this.root), { recursive: true });
    if (!repoPath) { await mkdir(dir, { recursive: true }); return dir; }
    const b = branch ?? `jj/${sessionId.slice(0, 8)}`;
    await run("git", ["-C", repoPath, "worktree", "add", "-b", b, dir]);
    return dir;
  }

  async release(sessionId: string, repoPath?: string) {
    const dir = resolve(this.root, sessionId);
    if (repoPath) await run("git", ["-C", repoPath, "worktree", "remove", "--force", dir]).catch(() => undefined);
  }
}
