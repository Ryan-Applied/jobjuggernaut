import { describe, it, expect } from "vitest";
import { waves } from "./workflows.js";
const st = (name: string, after?: string[]) => ({ name, prompt: "", maxCostGbp: 1, after });
describe("waves", () => {
  it("serial when no step declares after", () => { expect(waves([st("a"), st("b"), st("c")])).toEqual([[0], [1], [2]]); });
  it("parallel roots then dependents", () => {
    expect(waves([st("lint", []), st("tests", []), st("build", ["lint", "tests"]), st("deploy", ["build"]), st("notify", ["build"])])).toEqual([[0, 1], [2], [3, 4]]);
  });
  it("ignores unknown deps and self-deps", () => { expect(waves([st("a", ["zzz"]), st("b", ["a", "b"])])).toEqual([[0], [1]]); });
});
