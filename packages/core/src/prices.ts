/** B5: one dated price table for every vendor, in USD per million tokens, with a GBP conversion. */
export interface Price { inputPerM: number; outputPerM: number; asOf: string }
export const PRICES: Record<string, Price> = {
  "claude-sonnet-4-6": { inputPerM: 3, outputPerM: 15, asOf: "2026-06" },
  "claude-opus-4-6": { inputPerM: 15, outputPerM: 75, asOf: "2026-06" },
  "claude-haiku-4-5": { inputPerM: 0.8, outputPerM: 4, asOf: "2026-06" },
  "gpt-4.1": { inputPerM: 2, outputPerM: 8, asOf: "2026-06" },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6, asOf: "2026-06" },
  "gpt-5": { inputPerM: 1.25, outputPerM: 10, asOf: "2026-06" },
  "gemini-2.5-pro": { inputPerM: 1.25, outputPerM: 10, asOf: "2026-06" },
  "gemini-2.5-flash": { inputPerM: 0.3, outputPerM: 2.5, asOf: "2026-06" },
};
export const USD_TO_GBP = Number(process.env.JJ_USD_TO_GBP ?? 0.78);
export function priceFor(model: string): Price {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k)) ?? Object.keys(PRICES).find((k) => model.includes(k.split("-")[0])) ?? "claude-sonnet-4-6";
  return PRICES[key];
}
export function costGbp(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  return ((tokensIn / 1e6) * p.inputPerM + (tokensOut / 1e6) * p.outputPerM) * USD_TO_GBP;
}
