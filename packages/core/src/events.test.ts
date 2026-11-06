import { describe, expect, it } from "vitest";
import { SessionEvent, eventFactory } from "./index.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("session events", () => {
  it("stamps a session id, sequence, and timestamp on each event", () => {
    const emit = eventFactory(sessionId);
    const started = emit({
      type: "started",
      runnerId: "laptop",
      vendor: "openai",
      vendorSessionRef: "openai-session",
      workdir: "/work",
    });
    const message = emit({ type: "message", role: "assistant", text: "Ready" });

    expect(started).toMatchObject({ sessionId, seq: 0, type: "started" });
    expect(Number.isNaN(Date.parse(started.ts))).toBe(false);
    expect(message).toMatchObject({ sessionId, seq: 1, type: "message", tokensIn: 0, tokensOut: 0 });
  });

  it("rejects invalid event fields", () => {
    const result = SessionEvent.safeParse({
      sessionId,
      seq: 0,
      ts: new Date().toISOString(),
      type: "message",
      role: "assistant",
      text: "Hello",
      tokensIn: -1,
    });

    expect(result.success).toBe(false);
  });
});
