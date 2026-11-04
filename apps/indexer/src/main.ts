/** Indexer worker: runs IndexerActivities on the "indexer" queue. */
import { Worker, NativeConnection } from "@temporalio/worker";
import { sql } from "drizzle-orm";
import { createDb } from "@jj/graph";
import { indexSession, proposeForWorkflow, defaultEmbedder, compactEvents } from "@jj/indexer";
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
  async lessonInputs({ sessionId }) {
    const [n] = (await db.execute(sql`select props from nodes where id = ${sessionId}`)) as any[];
    if (!n?.props?.summary) return undefined;
    const near = (await db.execute(sql`select n.props->'summary' as summary from edges e join nodes n on n.id = e.dst where e.src = ${sessionId} and e.type = 'similar_to' order by e.weight desc limit 3`)) as any[];
    const [proj] = n.props.projectId ? (await db.execute(sql`select props->>'runnerId' as r from nodes where id = ${n.props.projectId}`)) as any[] : [undefined];
    return { summary: n.props.summary, neighbours: near.map((x) => x.summary), heuristic: n.props.lessons ?? [], runnerId: proj?.r ?? n.props.runnerId ?? "laptop" };
  },
  async storeLessons({ sessionId, lessons }) {
    await db.execute(sql`update nodes set props = props || ${JSON.stringify({ lessons: lessons.map((l) => l.text), lessonsDetail: lessons, lessonsBy: "model" })}::jsonb where id = ${sessionId}`);
  },
  async compactEvents() { return { deleted: await compactEvents(db) }; },
  async listWorkflowIds() {
    const rows = (await db.execute(sql`select id from nodes where type = 'workflow'`)) as any[];
    return rows.map((r) => r.id);
  },
};

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233" });
const worker = await Worker.create({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: INDEXER_QUEUE, activities });
console.log(`[indexer] listening on ${INDEXER_QUEUE} with ${embedder.name}`);
await worker.run();
