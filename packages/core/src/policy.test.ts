import { describe, expect, it } from "vitest";
import { Grant, Ledger, PolicyCheck } from "./index.js";

const id = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";

describe("policy schemas", () => {
  it("fills safe defaults for grants", () => {
    const grant = Grant.parse({
      id,
      ledgerId: taskId,
      action: "git.push",
      scope: { repo: "acme/app" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(grant).toMatchObject({ cap: {}, used: { count: 0, gbp: 0 }, delegated: false });
  });

  it("defaults optional resource and ledger history fields", () => {
    const check = PolicyCheck.parse({ sessionId: id, tool: "Read", args: {} });
    const ledger = Ledger.parse({
      id,
      taskId,
      generatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "draft",
      grants: [],
    });

    expect(check.resource).toEqual({});
    expect(ledger.neverPreAuthorised).toEqual([]);
  });
});
