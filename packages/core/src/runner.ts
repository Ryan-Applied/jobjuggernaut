import { SessionEvent } from "./events.js";
import type { z } from "zod";
import type { RunnerCapabilities, SessionInput, SessionSpec } from "./spec.js";
import type { PolicyCheck, PolicyResult } from "./policy.js";

export interface SessionHandle {
  sessionId: string;
  vendorSessionRef: string;
}

/** Every adapter calls this before any tool executes. */
export type PolicyChecker = (check: PolicyCheck) => Promise<PolicyResult>;

/** Resolves when the parked call has been approved (true) or denied (false). */
export type ApprovalWaiter = (sessionId: string, callId: string) => Promise<boolean>;

export interface RunnerContext {
  checkPolicy: PolicyChecker;
  waitForApproval: ApprovalWaiter;
}

export interface Runner {
  readonly id: string;
  capabilities(): Promise<RunnerCapabilities>;
  start(spec: SessionSpec, ctx: RunnerContext): Promise<SessionHandle>;
  stream(handle: SessionHandle): AsyncIterable<SessionEvent>;
  send(handle: SessionHandle, input: SessionInput): Promise<void>;
  cancel(handle: SessionHandle, reason: string): Promise<void>;
}

/** Stamps sessionId, seq and ts on every event an adapter emits. */
type Distribute<U> = U extends unknown ? Omit<U, "sessionId" | "seq" | "ts"> : never;
/** Input shape: zod defaults (tokensIn, bytes, ...) are optional here and filled by parse. */
export type SessionEventBody = Distribute<z.input<typeof SessionEvent>>;

export function eventFactory(sessionId: string) {
  let seq = 0;
  return (e: SessionEventBody): SessionEvent =>
    SessionEvent.parse({ ...e, sessionId, seq: seq++, ts: new Date().toISOString() });
}
