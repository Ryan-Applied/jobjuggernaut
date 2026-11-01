import { createDb, upsertSessionNode, addEdge } from "@jj/graph";
import type { CloudActivities } from "./activities.js";

export function createCloudActivities(): CloudActivities {
  const { db } = createDb();
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  return {
    async createSessionNode({ sessionId, title, props }) {
      await upsertSessionNode(db, sessionId, title, props);
    },
    async linkSessionToWorkflow({ sessionId, workflowId, taskId }) {
      await addEdge(db, sessionId, workflowId, "part_of").catch(() => undefined);
      await addEdge(db, sessionId, taskId, "part_of").catch(() => undefined);
    },
    async recordOutcome({ sessionId, outcome, spendGbp }) {
      await upsertSessionNode(db, sessionId, "", { state: outcome, spendGbp });
    },
    async postSlackCard({ sessionId, callId, gap }) {
      // Phase 3 wires Slack; Phase 1 surfaces the park on the API so the UI shows it.
      await fetch(`${apiUrl}/internal/parked`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, callId, gap }) }).catch(() => undefined);
    },
    async startIndexing({ sessionId }) {
      await fetch(`${apiUrl}/internal/index`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) }).catch(() => undefined);
    },
  };
}
