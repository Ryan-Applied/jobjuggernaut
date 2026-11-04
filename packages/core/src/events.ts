import { z } from "zod";

export const Vendor = z.enum(["claude", "openai", "gemini"]);
export type Vendor = z.infer<typeof Vendor>;

export const PolicyDecision = z.enum(["allow", "park", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

const base = z.object({
  sessionId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  ts: z.string().datetime(),
  raw: z.unknown().optional(),
});

export const SessionEvent = z.discriminatedUnion("type", [
  base.extend({
    type: z.literal("started"),
    runnerId: z.string(),
    vendor: Vendor,
    vendorSessionRef: z.string(),
    workdir: z.string(),
  }),
  base.extend({
    type: z.literal("message"),
    role: z.enum(["user", "assistant", "system"]),
    text: z.string(),
    /** Streaming delta of an in-progress assistant turn (B8). Not persisted as a turn. */
    partial: z.boolean().optional(),
    /** Set when the message belongs to a sub-agent (C4). */
    subagentId: z.string().optional(),
    tokensIn: z.number().int().nonnegative().default(0),
    tokensOut: z.number().int().nonnegative().default(0),
  }),
  base.extend({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()),
    policyDecision: PolicyDecision,
    grantId: z.string().uuid().optional(),
    subagentId: z.string().optional(),
  }),
  base.extend({
    type: z.literal("tool_result"),
    callId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    bytes: z.number().int().nonnegative().default(0),
  }),
  base.extend({
    type: z.literal("approval_request"),
    callId: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()),
    grantGap: z.string(),
    suggestedGrant: z.unknown().optional(),
  }),
  base.extend({
    type: z.literal("artifact"),
    kind: z.enum(["file", "pr", "page", "doc", "message", "other"]),
    uri: z.string(),
    title: z.string(),
  }),
  base.extend({
    type: z.literal("cost"),
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    costGbp: z.number().nonnegative(),
    cumulativeGbp: z.number().nonnegative(),
  }),
  base.extend({
    type: z.literal("done"),
    outcome: z.enum(["complete", "partial", "cancelled"]),
    summary: z.string(),
  }),
  base.extend({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
export type SessionEventType = SessionEvent["type"];
