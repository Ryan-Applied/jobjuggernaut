import { describe, expect, it } from "vitest";
import { PRICES, USD_TO_GBP, costGbp, priceFor } from "./index.js";

describe("model pricing", () => {
  it("uses the most specific matching model price", () => {
    expect(priceFor("gpt-4.1-mini-2025-04-14")).toEqual(PRICES["gpt-4.1-mini"]);
    expect(priceFor("claude-sonnet-4-6-latest")).toEqual(PRICES["claude-sonnet-4-6"]);
  });

  it("converts token usage to GBP", () => {
    expect(costGbp("gpt-4.1-mini", 1_000_000, 1_000_000)).toBeCloseTo(2 * USD_TO_GBP);
  });

  it("falls back to the default price for an unknown model", () => {
    expect(priceFor("unlisted-model")).toEqual(PRICES["claude-sonnet-4-6"]);
  });
});
