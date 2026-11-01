import { pgTable, uuid, text, jsonb, timestamp, integer, real, primaryKey, index, bigserial, customType } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() { return "vector(1024)"; },
  toDriver(v) { return `[${v.join(",")}]`; },
  fromDriver(v) { return v.slice(1, -1).split(",").map(Number); },
});

export const nodes = pgTable("nodes", {
  id: uuid("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  props: jsonb("props").notNull().default({}),
  embedding: vector("embedding"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ typeIdx: index("nodes_type_idx").on(t.type) }));

export const edges = pgTable("edges", {
  src: uuid("src").notNull().references(() => nodes.id),
  dst: uuid("dst").notNull().references(() => nodes.id),
  type: text("type").notNull(),
  weight: real("weight"),
  props: jsonb("props").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.src, t.dst, t.type] }), dstIdx: index("edges_dst_type_idx").on(t.dst, t.type) }));

export const sessionEvents = pgTable("session_events", {
  sessionId: uuid("session_id").notNull().references(() => nodes.id),
  seq: integer("seq").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.sessionId, t.seq] }) }));

export const ledgers = pgTable("ledgers", {
  id: uuid("id").primaryKey(),
  taskId: uuid("task_id").notNull().references(() => nodes.id),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  signature: text("signature"),
  status: text("status").notNull(),
});

export const grants = pgTable("grants", {
  id: uuid("id").primaryKey(),
  ledgerId: uuid("ledger_id").notNull().references(() => ledgers.id),
  action: text("action").notNull(),
  scope: jsonb("scope").notNull(),
  cap: jsonb("cap"),
  used: jsonb("used").notNull().default({ count: 0, gbp: 0 }),
  delegated: integer("delegated").notNull().default(0),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  sessionId: uuid("session_id"),
  tool: text("tool"),
  argsHash: text("args_hash"),
  decision: text("decision").notNull(),
  grantId: uuid("grant_id"),
  decidedBy: text("decided_by"),
  payload: jsonb("payload"),
});
