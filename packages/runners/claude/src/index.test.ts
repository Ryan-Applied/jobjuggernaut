import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSpec, type RunnerContext, type SessionEvent } from "@jj/core";
import { ClaudeRunner } from "./index.js";
import { runQuery, type SdkMessage } from "./sdk.js";

vi.mock("./sdk.js", () => ({ runQuery: vi.fn() }));

const runQueryMock = vi.mocked(runQuery);
const sessionId = "11111111-1111-4111-8111-111111111111";

function makeSpec(interactive = false) {
  return SessionSpec.parse({
    sessionId,
    workflowId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333",
    prompt: "Complete the task",
    workdir: "/work",
    budget: { maxCostGbp: 2 },
    interactive,
  });
}

function makeContext(overrides: Partial<RunnerContext> = {}): RunnerContext {
  return {
    checkPolicy: vi.fn(async () => ({ decision: "allow" as const, reason: "grant matched" })),
    waitForApproval: vi.fn(async () => true),
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => vi.clearAllMocks());

describe("ClaudeRunner", () => {
  it("checks tool policy and maps SDK results into session events", async () => {
    let allowed = false;
    runQueryMock.mockImplementation(async function* (options) {
      allowed = await options.onToolUse("Write", { path: "src/result.txt" }, "call-1");
      const messages: SdkMessage[] = [
        { kind: "assistant", text: "Finished", tokensIn: 12, tokensOut: 6, raw: {} },
        { kind: "tool_result", callId: "call-1", ok: true, summary: "saved", bytes: 5, raw: { content: "saved" } },
        { kind: "turn_done", tokensIn: 12, tokensOut: 6, costUsd: 0.01, raw: {} },
      ];
      yield* messages;
    });

    const context = makeContext();
    const runner = new ClaudeRunner();
    const handle = await runner.start(makeSpec(), context);
    const events = await collect(runner.stream(handle));

    expect(allowed).toBe(true);
    expect(context.checkPolicy).toHaveBeenCalledWith({
      sessionId,
      tool: "Write",
      args: { path: "src/result.txt" },
      resource: {},
    });
    expect(events.map((event) => event.type)).toEqual([
      "started", "tool_call", "message", "tool_result", "artifact", "cost", "done",
    ]);
    expect(events.find((event) => event.type === "artifact")).toMatchObject({
      kind: "file",
      uri: "/work/src/result.txt",
    });
  });

  it("delivers a queued final follow-up before completing an interactive session", async () => {
    runQueryMock.mockImplementation(async function* (options) {
      for await (const followUp of options.followUps ?? []) {
        yield { kind: "assistant", text: `Received: ${followUp}`, tokensIn: 0, tokensOut: 0, raw: {} };
      }
    });

    const runner = new ClaudeRunner();
    const handle = await runner.start(makeSpec(true), makeContext());
    await runner.send(handle, { text: "Final note", final: true });
    const events = await collect(runner.stream(handle));

    expect(events).toContainEqual(expect.objectContaining({ type: "message", role: "user", text: "Final note" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", text: "Received: Final note" }));
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "complete" });
  });
});
