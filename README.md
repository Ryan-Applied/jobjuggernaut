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

## How a day runs

1. **Today** shows one card per project: last session, parked items, go-aheads waiting, spend, lessons. Continue a project in **auto** (template grants signed, pauses only on forbid rules and caps), **assist** (template grants minus outward actions, pauses between steps for your go-ahead) or **manual** (no grants, every call parks). Or **Queue tonight**.
2. A project is a name, a repo or folder to work in (repo => worktree per session, folder => in place, none => scratch), a goal, a default mode and a grant template. Every session starts with a **continuation pack**: the goal, the last sessions' outcomes and lessons, open approvals, and a live look at the workdir (branch, dirty files, recent commits, CLAUDE.md). "Bring in" a session from another project to fold its prompt and lessons into the pack.
3. **Approvals**: draft ledgers for tonight's queue (edit caps, drop grants, sign), parked calls (approve once / add to grant / deny), assist go-aheads. Slack gets the same card when configured.
4. **Chores** are Temporal Schedules; each fire builds a fresh task and ledger from the project's current template. System schedules: overnight batch 22:00, nightly learn 03:00.
5. **Runners** heartbeat into a registry (`GET /runners`); the sidebar shows what is live. Worktrees are cleaned after a session that left no commits or changes; otherwise kept and reported on the session. Artifacts (files written, PRs, pages, messages) become `produced` edges. Sub-agent activity becomes child sessions with `spawned` edges.
6. **Ingest**: point the platform at a repo or folder (plus a hint), or paste a runbook; an LLM on the runner drafts the project (goal, continue steps, intended actions, read-only grant template, skills, epics, a suggested chore) or the workflow (steps, prompts, connectors, actions). Review, edit, accept. After every indexed session the LLM reassesses the project: status, done, in progress, blocked, next steps, risks, and the prompt the next session should run; that drives the Today card and the default Continue prompt. Needs `ANTHROPIC_API_KEY` on the runner; without it (or with `JJ_MOCK_RUNNER=1`) a deterministic offline drafter is used.
7. The **indexer** embeds each finished session, links similar ones, extracts lessons (heuristic, then rewritten by the model on the project's runner when a key is present), proposes grant-template and skill edits (kinds you keep rejecting are suppressed), compacts raw events past the retention window, and maintains a per-project memory (decisions, conventions, open questions) that every continuation pack includes. Accepted skill edits commit on a branch and, with `SKILLS_PR=1` and `gh`, open a PR.

## Workflow steps: DAG, retries, budgets, interaction

- `after: ["lint","tests"]` on a step makes it wait for those; steps with `after: []` form the first wave and run in parallel. Without any `after`, steps run serially as before.
- `retry: 1` re-runs a failed step once; `onFailure: "continue" | "stop" | "run:<step>"` decides what happens after retries are exhausted (compensation steps run once and are then skipped in the plan).
- Tasks carry `budgetGbp` (default: sum of step caps × 1.1) and `deadline`; the task stops with `over_budget` or `deadline` between waves. `priority` orders the overnight batch; `runnerAffinity: "any"` lets the batch pick a live runner from the registry.
- `interactive: true` on a step keeps the session open after its first turn; `POST /sessions/:id/send {text, final?}` (or Nudge on the graph page) feeds follow-ups; it closes on `final` or after `idleMinutes`.
- Tasks pause between waves with `POST /tasks/:id/pause`; projects pause with `POST /projects/:id/pause` (refuses continues, pauses chores).

## Gotchas found on first run

- Local Postgres on 5432 or 5433 (Postgres.app, Homebrew) silently wins over the container. Compose maps the container to **5440**; `.env.example` matches.
- Temporal's image cannot write to a root-owned volume, so dev runs in-memory; workflow history resets with the container.
- `nvm` plus `npm_config_prefix` breaks `pnpm` in fresh tmux panes; `scripts/dev.sh` unsets it.
- Nothing loads `.env` for you yet: `set -a; source .env; set +a` before any `pnpm dev:*`, or use `pnpm dev` (tmux) which does it.

## Tests

- `pnpm test` runs unit tests (policy matcher).
- `pnpm test:integration` runs the Phase 1 exit test with the **mock runner** against a Temporal server on `TEMPORAL_ADDRESS`, in its own namespace (`jj-test`), so it is safe alongside the dev stack: 5 parallel sessions visible under 2 s, park → approve → resume, grant allow, approver deny, cancel mid-run, and runner-daemon restart mid-session.
- `pnpm dev:mock` runs the whole stack with the mock runner so the UI can be exercised with no vendor keys.

## Deploying

- **Always-on box** (Mac mini, small Linux host): `docker compose -f docker-compose.prod.yml up -d --build` runs Postgres, Temporal, the API, cloud worker, indexer and a runner; mount your project folders under `PROJECTS_ROOT`. Your laptop runs only `pnpm dev:runner` pointed at it.
- **AWS**: `infra/terraform` builds the VPC, RDS Postgres 16 (run the migration to enable pgvector), ECS Fargate services from the multi-target `Dockerfile` (`--target api|cloud-worker|indexer`), a Tailscale subnet router, and an S3 Object Lock bucket for the audit mirror. Temporal Cloud is assumed; set `temporal_address`.
- **Slack**: a bot with `chat:write`, interactivity URL `{API_URL}/slack/interactions`, and `SLACK_*` in the API's environment.

## Layout

```
packages/core        Zod schemas: SessionEvent, SessionSpec, Grant, Ledger; Runner interface
packages/policy      forbid rules, grant matcher, GrantCache (shared by cache and service)
packages/graph       Drizzle schema, migrations, graph queries
packages/workflows   Temporal: SessionWorkflow, TaskWorkflow, cloud worker
packages/runners/*   claude (Agent SDK, PreToolUse hook), gemini (CLI, read-only reviewer), openai (Responses API, function tools), mock (tests)
apps/runner-daemon   local Temporal worker, worktrees, grant cache, event batcher
apps/api             Hono: ingest, SSE, projects, workflows, ledgers, approvals, chores, brief, Slack
apps/web             Next.js: Today, Sessions, Graph, Workflows, Project, Approvals, Chores, Proposals
apps/indexer         indexer worker (indexer queue)
infra/terraform      cloud shape, applied after the Phase 1 gate
skills/              SKILL.md per skill
```

## Phase 1 exit test

Start five tasks, three Claude and two Gemini. All five appear in the grid within 2 s, stream events, show cost; cancel one from the UI. Kill and restart `runner-daemon` mid-run; Temporal retries `startSession` and the sessions resume.
