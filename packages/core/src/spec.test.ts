import { describe, expect, it } from "vitest";
import { SessionInput, SessionSpec, StepDraft } from "./index.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const workflowId = "22222222-2222-4222-8222-222222222222";
const taskId = "33333333-3333-4333-8333-333333333333";

describe("session and draft schemas", () => {
  it("applies SessionSpec defaults", () => {
    const spec = SessionSpec.parse({
      sessionId,
      workflowId,
      taskId,
      prompt: "Build the feature",
      workdir: "/work",
      budget: { maxCostGbp: 3 },
    });

    expect(spec).toMatchObject({
      mode: "assist",
      stepIndex: 0,
      skills: [],
      connectors: [],
      grantIds: [],
      requires: [],
    });
  });

  it("rejects invalid session identifiers and budgets", () => {
    const invalidId = SessionSpec.safeParse({
      sessionId: "not-a-uuid",
      workflowId,
      taskId,
      prompt: "Build the feature",
      workdir: "/work",
      budget: { maxCostGbp: 3 },
    });
    const invalidBudget = SessionSpec.safeParse({
      sessionId,
      workflowId,
      taskId,
      prompt: "Build the feature",
      workdir: "/work",
      budget: { maxCostGbp: 0 },
    });

    expect(invalidId.success).toBe(false);
    expect(invalidBudget.success).toBe(false);
  });

  it("applies StepDraft defaults and keeps SessionInput final optional", () => {
    expect(StepDraft.parse({ name: "test", prompt: "Run checks" })).toMatchObject({
      skills: [],
      connectors: [],
      intendedActions: [],
      maxCostGbp: 2,
    });
    expect(SessionInput.parse({ text: "Continue" })).toEqual({ text: "Continue" });
  });
});
