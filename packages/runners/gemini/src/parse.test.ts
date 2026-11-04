import { describe, it, expect } from "vitest";
import { parseLine } from "./parse.js";
describe("gemini stream-json parser", () => {
  it("accepts flat and nested shapes", () => {
    expect(parseLine('{"type":"assistant","content":"hi"}')[0]).toMatchObject({ kind: "text", text: "hi" });
    expect(parseLine('{"type":"message","content":[{"type":"text","text":"a"},{"functionCall":{"name":"read_file","args":{"path":"x"}},"id":"c1"}]}').map((p) => p.kind)).toEqual(["text", "tool_call"]);
    expect(parseLine('{"type":"tool_result","id":"c1","output":"ok"}')[0]).toMatchObject({ kind: "tool_result", ok: true });
    expect(parseLine('{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}')[0]).toMatchObject({ kind: "usage", tokensIn: 10, tokensOut: 5 });
    expect(parseLine("not json")).toEqual([]);
  });
});
