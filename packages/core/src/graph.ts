export const NODE_TYPES = [
  "session", "task", "workflow", "chore", "agent", "skill",
  "connector", "runner", "grant", "approval", "artifact", "person", "account", "project", "proposal",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  "similar_to", "spawned", "part_of", "scheduled_by", "uses_skill", "touched",
  "ran_on", "authorised_by", "required_approval", "produced", "relates_to", "superseded_by", "derived_from", "belongs_to",
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];
