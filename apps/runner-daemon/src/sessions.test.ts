import { describe, expect, it } from "vitest";
import { SessionSpec, type Runner } from "@jj/core";
import type { ApiLike } from "./api.js";
import { SessionManager } from "./sessions.js";
import type { WorktreeManager } from "./worktrees.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

function spec(overrides: Record<string, unknown> = {}) {
  return SessionSpec.parse({
    sessionId,
    workflowId: "22222222-2222-4222-8222-222222222222",
    taskId: "33333333-3333-4333-8333-333333333333",
    prompt: "Do the work",
    workdir: "/work",
    budget: { maxCostGbp: 2 },
    ...overrides,
  });
}

function runner(id: string) {
  return { id } as unknown as Runner;
}

function manager(runners: Record<string, Runner>) {
  return new SessionManager({} as ApiLike, {} as WorktreeManager, "host", runners);
}

describe("SessionManager runner selection", () => {
  const claude = runner("claude-host");
  const openai = runner("openai-host");
  const gemini = runner("gemini-host");

  it("honors a supported preferred vendor", () => {
    expect(manager({ claude, openai, gemini }).pick(spec({ preferredVendor: "openai" }))).toBe(openai);
  });

  it("uses reviewer ordering while skipping the vendor to avoid", () => {
    const selected = manager({ claude, openai, gemini }).pick(spec({
      reviewerOf: "44444444-4444-4444-8444-444444444444",
      avoidVendor: "gemini",
    }));

    expect(selected).toBe(openai);
  });

  it("reports when no runners are configured", () => {
    expect(() => manager({}).pick(spec())).toThrow("no runners configured");
  });
});
