import { z } from "zod";
import { Vendor } from "./events.js";

export const SessionSpec = z.object({
  sessionId: z.string().uuid(),
  workflowId: z.string().uuid(),
  taskId: z.string().uuid(),
  stepIndex: z.number().int().nonnegative().default(0),
  prompt: z.string(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).default([]),
  connectors: z.array(z.string()).default([]),
  grantIds: z.array(z.string().uuid()).default([]),
  workdir: z.string(),
  budget: z.object({
    maxTokens: z.number().int().positive().optional(),
    maxCostGbp: z.number().positive(),
    deadline: z.string().datetime().optional(),
  }),
  requires: z.array(z.string()).default([]),
  preferredVendor: Vendor.optional(),
  reviewerOf: z.string().uuid().optional(),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

export const RunnerCapabilities = z.object({
  runnerId: z.string(),
  vendor: Vendor,
  tools: z.array(z.string()),
  maxContextTokens: z.number().int().positive(),
  supportsResume: z.boolean(),
  supportsSubagents: z.boolean(),
  costModel: z.object({
    inputPer1k: z.number().nonnegative(),
    outputPer1k: z.number().nonnegative(),
    currency: z.literal("GBP"),
  }),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilities>;

export const SessionInput = z.object({ text: z.string() });
export type SessionInput = z.infer<typeof SessionInput>;
