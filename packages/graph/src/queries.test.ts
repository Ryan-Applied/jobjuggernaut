import { describe, expect, it, vi } from "vitest";
import type { Db } from "./db.js";
import { appendEvents, neighbourhood, similarSessions, workflowRuns } from "./queries.js";

function fakeDb(...responses: unknown[][]) {
  const execute = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  return { db: { execute } as unknown as Db, execute };
}

describe("graph queries", () => {
  it("returns stored similar-session edges without querying embeddings", async () => {
    const rows = [{ id: "session-near", weight: 0.9 }];
    const { db, execute } = fakeDb(rows);

    await expect(similarSessions(db, "session-current", 3)).resolves.toBe(rows);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("falls back to embedding similarity when there are no stored edges", async () => {
    const rows = [{ id: "session-near", weight: 0.75 }];
    const { db, execute } = fakeDb([], rows);

    await expect(similarSessions(db, "session-current", 4)).resolves.toBe(rows);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("returns workflow runs and neighbourhood rows from the database", async () => {
    const runs = [{ id: "session-1" }];
    const adjacent = [{ id: "task-1", edge: "part_of" }];
    const { db, execute } = fakeDb(runs, adjacent);

    await expect(workflowRuns(db, "workflow-1", 10)).resolves.toBe(runs);
    await expect(neighbourhood(db, "workflow-1")).resolves.toBe(adjacent);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not issue an insert for an empty event batch", async () => {
    const insert = vi.fn();
    const db = { insert } as unknown as Db;

    await appendEvents(db, []);

    expect(insert).not.toHaveBeenCalled();
  });
});
