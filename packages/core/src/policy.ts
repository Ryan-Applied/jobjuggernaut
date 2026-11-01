import { z } from "zod";

/** A grant is scope + cap + expiry. There is no "allow all". */
export const Grant = z.object({
  id: z.string().uuid(),
  ledgerId: z.string().uuid(),
  action: z.string(),
  scope: z.record(z.union([z.string(), z.array(z.string())])),
  cap: z.object({ count: z.number().int().positive().optional(), gbp: z.number().positive().optional() }).default({}),
  used: z.object({ count: z.number().int().nonnegative(), gbp: z.number().nonnegative() }).default({ count: 0, gbp: 0 }),
  expiresAt: z.string().datetime(),
  delegated: z.boolean().default(false),
});
export type Grant = z.infer<typeof Grant>;

export const Ledger = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  signedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime(),
  signature: z.string().optional(),
  status: z.enum(["draft", "signed", "expired", "revoked"]),
  grants: z.array(Grant),
  neverPreAuthorised: z.array(z.object({ action: z.string(), reason: z.string() })).default([]),
});
export type Ledger = z.infer<typeof Ledger>;

export const PolicyCheck = z.object({
  sessionId: z.string().uuid(),
  tool: z.string(),
  args: z.record(z.unknown()),
  resource: z.record(z.unknown()).default({}),
});
export type PolicyCheck = z.infer<typeof PolicyCheck>;

export const PolicyResult = z.object({
  decision: z.enum(["allow", "park", "deny"]),
  grantId: z.string().uuid().optional(),
  reason: z.string(),
  gap: z.string().optional(),
});
export type PolicyResult = z.infer<typeof PolicyResult>;
