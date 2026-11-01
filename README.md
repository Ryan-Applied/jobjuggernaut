# jobjuggernaut

A personal agent control plane: run many agent sessions in parallel across vendors, see them in one place, link them in a graph, and run long-tail work overnight under scoped grants you signed before bed.

Design: [Agent Control Plane: Design Document](https://claude.ai/artifact/6FCJpEk5VDXpuVNgAExaTV). Wireframes: [canvas](https://claude.ai/artifact/LBYRjK6ZcQvEmzaZjgFwR6).

## Phase 1: run and see

Everything runs on the laptop. No cloud account needed.

```bash
pnpm install
cp .env.example .env           # add ANTHROPIC_API_KEY; GEMINI_API_KEY optional
pnpm dev:infra                 # Postgres + pgvector, Temporal dev server (UI on :8233)
pnpm db:migrate
pnpm dev:workflows             # cloud worker: workflow code + cloud activities
pnpm dev:runner                # local worker: the only process holding credentials
pnpm dev:api                   # :4000, SSE at /events
pnpm dev:web                   # :3000
```

Start a session from the UI, or:

```bash
curl -s localhost:4000/tasks -H 'content-type: application/json' -d '{
  "title": "Say hello", "workflowId": "00000000-0000-4000-8000-000000000001",
  "steps": [{ "name": "hello", "prompt": "List the files here and say hello.", "maxCostGbp": 0.5 }]
}'
```

With no grants loaded, every tool call parks and shows Approve once / Deny in the UI. That is the policy layer working, not a bug.

## Layout

```
packages/core        Zod schemas: SessionEvent, SessionSpec, Grant, Ledger; Runner interface
packages/policy      forbid rules, grant matcher, GrantCache (shared by cache and service)
packages/graph       Drizzle schema, migrations, graph queries
packages/workflows   Temporal: SessionWorkflow, TaskWorkflow, cloud worker
packages/runners/*   claude (Agent SDK), gemini (CLI, read-only reviewer)
apps/runner-daemon   local Temporal worker, worktrees, grant cache, event batcher
apps/api             Hono: ingest, SSE, grants, audit, task start, approvals
apps/web             Next.js: Sessions screen
apps/indexer         Phase 2; structural edges only for now
infra/terraform      cloud shape, applied after the Phase 1 gate
skills/              SKILL.md per skill
```

## Phase 1 exit test

Start five tasks, three Claude and two Gemini. All five appear in the grid within 2 s, stream events, show cost; cancel one from the UI. Kill and restart `runner-daemon` mid-run; Temporal retries `startSession` and the sessions resume.
