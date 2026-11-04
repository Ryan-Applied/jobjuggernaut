/** Read-only look at a workdir: the facts the drafts are built from. Bounded so prompts stay small. */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

export interface WorkdirFacts {
  path: string; isRepo: boolean; branch?: string; recentCommits: string[]; branches: string[];
  tree: string[]; manifests: Record<string, string>; docs: Record<string, string>; totalFiles: number;
}

const DOC_NAMES = ["README.md", "readme.md", "CLAUDE.md", "AGENTS.md", "ROADMAP.md", "TODO.md", "CHANGELOG.md", "docs/README.md", "docs/architecture.md", "docs/design.md"];
const MANIFESTS = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "docker-compose.yml", "Makefile", "Taskfile.yml", ".github/workflows"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "venv", ".venv", "__pycache__", ".worktrees"]);

export async function collectFacts(path: string, maxChars = 24_000): Promise<WorkdirFacts> {
  const root = resolve(path);
  const g = (...a: string[]) => run("git", ["-C", root, ...a]).then((r) => r.stdout.trim()).catch(() => "");
  const isRepo = !!(await g("rev-parse", "--is-inside-work-tree"));
  const facts: WorkdirFacts = { path: root, isRepo, recentCommits: [], branches: [], tree: [], manifests: {}, docs: {}, totalFiles: 0 };
  if (isRepo) {
    facts.branch = await g("rev-parse", "--abbrev-ref", "HEAD");
    facts.recentCommits = (await g("log", "--oneline", "-25")).split("\n").filter(Boolean);
    facts.branches = (await g("branch", "--format=%(refname:short)", "--sort=-committerdate")).split("\n").filter(Boolean).slice(0, 12);
  }
  // tree, 2 levels
  const walk = async (dir: string, depth: number) => {
    let entries: any[] = []; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".") && e.name !== ".github") continue;
      const rel = relative(root, join(dir, e.name)); facts.totalFiles++;
      if (facts.tree.length < 200) facts.tree.push(e.isDirectory() ? rel + "/" : rel);
      if (e.isDirectory() && depth < 2) await walk(join(dir, e.name), depth + 1);
    }
  };
  await walk(root, 0);
  let budget = maxChars;
  const take = async (rel: string, into: Record<string, string>, cap: number) => {
    try { const p = join(root, rel); const s = await stat(p); if (!s.isFile()) return; let t = await readFile(p, "utf8"); if (t.length > cap) t = t.slice(0, cap) + "\n…"; if (t.length <= budget) { into[rel] = t; budget -= t.length; } } catch {}
  };
  for (const d of DOC_NAMES) await take(d, facts.docs, 6000);
  for (const m of MANIFESTS) await take(m, facts.manifests, 2500);
  return facts;
}

export function factsToText(f: WorkdirFacts): string {
  const parts = [`Path: ${f.path}`, f.isRepo ? `Git: branch ${f.branch}; branches ${f.branches.join(", ")}` : "Not a git repo", `Files (top levels, ${f.totalFiles} total):\n${f.tree.join("\n")}`];
  if (f.recentCommits.length) parts.push(`Recent commits:\n${f.recentCommits.join("\n")}`);
  for (const [k, v] of Object.entries(f.docs)) parts.push(`--- ${k} ---\n${v}`);
  for (const [k, v] of Object.entries(f.manifests)) parts.push(`--- ${k} ---\n${v}`);
  return parts.join("\n\n");
}
