import { describe, expect, it } from "vitest";
import { SessionSpec, type RunnerContext, type SessionEvent } from "@jj/core";
import { MockRunner } from "./index.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

function interactiveSpec() {
  return SessionSpec.parse({
    sessionId,
    workflowId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333",
    prompt: "slow:20",
    workdir: "/work",
    budget: { maxCostGbp: 2 },
    interactive: true,
  });
}

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("MockRunner", () => {
  it("processes a queued final follow-up before closing", async () => {
    const context: RunnerContext = {
      checkPolicy: async () => ({ decision: "allow", reason: "grant matched" }),
      waitForApproval: async () => true,
    };
    const runner = new MockRunner();
    const handle = await runner.start(interactiveSpec(), context);

    await runner.send(handle, { text: "Final note", final: true });
    const events = await collect(runner.stream(handle));

    expect(events).toContainEqual(expect.objectContaining({
      type: "message",
      role: "assistant",
      text: "mock: follow-up \"Final note\"",
    }));
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "complete" });
  });
});
