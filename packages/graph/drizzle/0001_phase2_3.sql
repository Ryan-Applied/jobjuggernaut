-- Phase 2/3: ledger intent + signing fields, grant usage reconciliation, proposals live in nodes.
alter table ledgers add column if not exists intended jsonb not null default '[]';
alter table ledgers add column if not exists never_pre_authorised jsonb not null default '[]';
alter table ledgers add column if not exists signed_by text;
alter table grants add column if not exists expires_at timestamptz;
create index if not exists session_events_type_idx on session_events (type);
create index if not exists nodes_props_state_idx on nodes ((props->>'state'));
create index if not exists nodes_props_workflow_idx on nodes ((props->>'workflowId'));
