create extension if not exists vector;

create table if not exists nodes (
  id          uuid primary key,
  type        text not null,
  title       text not null,
  props       jsonb not null default '{}',
  embedding   vector(1024),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists nodes_type_idx on nodes (type);
create index if not exists nodes_embedding_idx on nodes using hnsw (embedding vector_cosine_ops);

create table if not exists edges (
  src         uuid not null references nodes(id),
  dst         uuid not null references nodes(id),
  type        text not null,
  weight      real,
  props       jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  primary key (src, dst, type)
);
create index if not exists edges_dst_type_idx on edges (dst, type);

create table if not exists session_events (
  session_id  uuid not null references nodes(id),
  seq         integer not null,
  ts          timestamptz not null,
  type        text not null,
  payload     jsonb not null,
  primary key (session_id, seq)
);

create table if not exists ledgers (
  id            uuid primary key,
  task_id       uuid not null references nodes(id),
  generated_at  timestamptz not null,
  signed_at     timestamptz,
  expires_at    timestamptz not null,
  signature     text,
  status        text not null
);

create table if not exists grants (
  id          uuid primary key,
  ledger_id   uuid not null references ledgers(id),
  action      text not null,
  scope       jsonb not null,
  cap         jsonb,
  used        jsonb not null default '{"count":0,"gbp":0}',
  delegated   integer not null default 0
);

create table if not exists audit_log (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  session_id  uuid,
  tool        text,
  args_hash   text,
  decision    text not null,
  grant_id    uuid,
  decided_by  text,
  payload     jsonb
);
