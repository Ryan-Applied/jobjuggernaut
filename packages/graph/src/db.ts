import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export function createDb(url = process.env.DATABASE_URL ?? "postgres://jj:jj@localhost:5432/jj") {
  const client = postgres(url, { max: 10 });
  return { db: drizzle(client, { schema }), client };
}
export type Db = ReturnType<typeof createDb>["db"];
