import { describe, expect, it } from "vitest";
import { resolveRunnerId } from "./runner-selection.js";

describe("resolveRunnerId", () => {
  it("prefers an explicitly requested runner", () => {
    expect(resolveRunnerId("request-runner", "workflow-runner", "configured-runner")).toBe("request-runner");
  });

  it("uses the workflow runner before the configured default", () => {
    expect(resolveRunnerId(undefined, "workflow-runner", "configured-runner")).toBe("workflow-runner");
  });

  it("falls back to the configured default, then laptop", () => {
    expect(resolveRunnerId(undefined, undefined, "configured-runner")).toBe("configured-runner");
    expect(resolveRunnerId()).toBe("laptop");
  });
});
