# Workflow library

Workflows the control plane runs on itself. Each JSON file is a `WorkflowDef`; load them with
`./scripts/seed-workflows.sh` (add `--chores` to also create the suggested schedules).
Agents in these sessions use the control plane API at `$API_URL`, so run them in **auto** mode
with the default grant template (read-only tools plus Bash for curl); anything outward
(Slack, push, PR) is declared on the step that needs it and parks for approval.

| Workflow | Purpose | Suggested cadence |
| --- | --- | --- |
| project-onboard | Make a folder session-ready: ONBOARDING.md, CLAUDE.md, register the project, second-vendor review | On demand |
| workflow-from-runbook | Draft a workflow from a runbook, dry-run its ledger, fix until the grants are right | On demand |
| research-project-setup | Frame a research question, vet sources, schedule a digest chore | On demand |
| morning-standup | Decisions needed first, then per-project status; posts to Slack after approval | 08:00 weekdays |
| pr-shepherd | Test and rebase jj/* branches, open PRs (park), second-vendor review | 17:00 weekdays |
| grant-template-tune | Parks and unused grants into template changes | Monday 08:30 |
| stale-project-sweep | Idle projects: where they stand, continue / pause / archive | Friday 09:00 |
| chore-health | Chores that skip, fail or cost too much; pauses the broken ones | 08:15 weekdays |
| session-postmortem | Timeline, root cause, three concrete changes; compare with similar successes | On demand (give a session id) |
| cost-audit | Spend by project, vendor, workflow; outliers; caps | Monday 09:00 |
| cross-project-lessons | Cluster lessons across projects into candidate shared skills | Friday 10:00 |
| workflow-benchmark | Same workflow on two vendors; compare outcome, cost, parks | On demand |

To run one on demand: Workflows → open it → Run now, or `POST /tasks {"workflowId": "..."}`.
Session-specific ones (postmortem, benchmark) want the id in the prompt: use Continue on a project
with the prompt "Postmortem for session <id>" and the workflow's steps.
