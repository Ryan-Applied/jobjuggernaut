import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
const sql = postgres(process.env.DATABASE_URL ?? "postgres://jj:jj@localhost:5432/jj", { max: 1, onnotice: () => {} });

await sql`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
  const done = await sql`select 1 from _migrations where name = ${f}`;
  if (done.length) continue;
  await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  await sql`insert into _migrations (name) values (${f})`;
  console.log("applied", f);
}
await sql.end();
