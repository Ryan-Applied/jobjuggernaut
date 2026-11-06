import { describe, expect, it, vi } from "vitest";
import { SessionSpec, type RunnerContext, type SessionEvent } from "@jj/core";
import { OpenAIRunner } from "./index.js";

vi.mock("openai", () => ({
  default: class {
    responses = { create: vi.fn() };
  },
}));

const sessionId = "11111111-1111-4111-8111-111111111111";

function interactiveSpec() {
  return SessionSpec.parse({
    sessionId,
    workflowId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333",
    prompt: "Complete the tool work",
    workdir: "/work",
    budget: { maxCostGbp: 2 },
    interactive: true,
  });
}

function response(output: unknown[], output_text = "") {
  return { output, output_text, usage: { input_tokens: 1, output_tokens: 1 } };
}

async function collect(stream: AsyncIterable<SessionEvent>) {
  const events: SessionEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenAIRunner", () => {
  it("sends a queued final follow-up after outstanding tool calls finish", async () => {
    let releaseFirst!: (value: ReturnType<typeof response>) => void;
    const firstResponse = new Promise<ReturnType<typeof response>>((resolve) => { releaseFirst = resolve; });
    const create = vi.fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(response([], "Tool work finished"))
      .mockResolvedValueOnce(response([], "Follow-up handled"));
    const context: RunnerContext = {
      checkPolicy: async () => ({ decision: "deny", reason: "no grant" }),
      waitForApproval: async () => false,
    };
    const runner = new OpenAIRunner();
    (runner as any).client = { responses: { create } };
    const handle = await runner.start(interactiveSpec(), context);

    await runner.send(handle, { text: "Final note", final: true });
    releaseFirst(response([
      { type: "function_call", call_id: "call-1", name: "Read", arguments: "{\"path\":\"private.txt\"}" },
    ]));
    const events = await collect(runner.stream(handle));

    expect(create).toHaveBeenCalledTimes(3);
    expect(events).toContainEqual(expect.objectContaining({ type: "message", role: "user", text: "Final note" }));
    expect(events.at(-1)).toMatchObject({ type: "done", outcome: "complete" });
  });
});
