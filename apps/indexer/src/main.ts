/**
 * Phase 2. Turns a finished session into graph structure:
 *   summary -> embedding (Voyage 3) -> similar_to edges -> structural edges -> lessons.
 * Phase 1 ships the structural-edge pass only so the graph explorer has something to show.
 */
import { createDb, addEdge } from "@jj/graph";
import { sql } from "drizzle-orm";

const { db } = createDb();

export async function indexSession(sessionId: string) {
  const events = await db.execute(sql`select payload from session_events where session_id = ${sessionId} order by seq`);
  const touched = new Map<string, number>();
  for (const r of events as any[]) {
    const e = r.payload;
    if (e.type === "tool_call") {
      const connector = String(e.tool).split(".")[0];
      touched.set(connector, (touched.get(connector) ?? 0) + 1);
    }
  }
  for (const [connector, n] of touched) {
    const id = await connectorNode(connector);
    await addEdge(db, sessionId, id, "touched", n);
  }
  return { touched: [...touched.entries()] };
}

async function connectorNode(name: string): Promise<string> {
  const rows = await db.execute(sql`select id from nodes where type = 'connector' and title = ${name}`);
  if (rows.length) return (rows[0] as any).id;
  const id = crypto.randomUUID();
  await db.execute(sql`insert into nodes (id, type, title) values (${id}, 'connector', ${name})`);
  return id;
}

if (process.argv[2]) indexSession(process.argv[2]).then((r) => { console.log(r); process.exit(0); });
