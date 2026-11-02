/** Indexer worker: runs IndexerActivities on the "indexer" queue. */
import { Worker, NativeConnection } from "@temporalio/worker";
import { sql } from "drizzle-orm";
import { createDb } from "@jj/graph";
import { indexSession, proposeForWorkflow, defaultEmbedder } from "@jj/indexer";
import { INDEXER_QUEUE, type IndexerActivities } from "@jj/workflows";

const { db } = createDb();
const embedder = defaultEmbedder();

const activities: IndexerActivities = {
  async indexSession({ sessionId }) {
    const r = await indexSession(db, sessionId, embedder);
    console.log(`[indexer] ${sessionId.slice(0, 8)} similar=${r.similar.length} edges=${r.edges} lessons=${r.lessons.length}`);
    return { similar: r.similar.length, edges: r.edges, lessons: r.lessons.length };
  },
  async proposeForWorkflow({ workflowId }) {
    const ids = await proposeForWorkflow(db, workflowId);
    return { proposals: ids.length };
  },
  async listWorkflowIds() {
    const rows = (await db.execute(sql`select id from nodes where type = 'workflow'`)) as any[];
    return rows.map((r) => r.id);
  },
};

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
const worker = await Worker.create({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: INDEXER_QUEUE, activities });
console.log(`[indexer] listening on ${INDEXER_QUEUE} with ${embedder.name}`);
await worker.run();
