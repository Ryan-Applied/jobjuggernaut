/**
 * B4: tolerant parser for Gemini CLI stream-json lines. The CLI's shapes have moved between
 * versions; this accepts the variants seen so far and ignores anything it does not recognise.
 */
export type Parsed =
  | { kind: "text"; text: string; raw: unknown }
  | { kind: "tool_call"; callId: string; tool: string; args: Record<string, unknown>; raw: unknown }
  | { kind: "tool_result"; callId: string; ok: boolean; text: string; raw: unknown }
  | { kind: "usage"; tokensIn: number; tokensOut: number; raw: unknown };

export function parseLine(line: string): Parsed[] {
  let m: any; try { m = JSON.parse(line); } catch { return []; }
  const out: Parsed[] = [];
  const t = m.type ?? m.event ?? "";
  const content = Array.isArray(m.content) ? m.content : Array.isArray(m.message?.content) ? m.message.content : undefined;
  if (content) {
    for (const c of content) {
      if (c.type === "text" && c.text) out.push({ kind: "text", text: c.text, raw: m });
      if (c.type === "functionCall" || c.type === "tool_use" || c.functionCall) { const fc = c.functionCall ?? c; out.push({ kind: "tool_call", callId: c.id ?? fc.id ?? crypto.randomUUID(), tool: fc.name ?? c.name ?? "unknown", args: fc.args ?? c.input ?? {}, raw: m }); }
      if (c.type === "functionResponse" || c.type === "tool_result" || c.functionResponse) { const fr = c.functionResponse ?? c; out.push({ kind: "tool_result", callId: c.id ?? fr.id ?? c.tool_use_id ?? "", ok: !(fr.response?.error ?? c.is_error), text: String(fr.response?.output ?? fr.response?.result ?? c.content ?? ""), raw: m }); }
    }
  } else if (t === "assistant" || t === "message" || t === "content") {
    const text = typeof m.content === "string" ? m.content : m.text ?? m.message?.text ?? "";
    if (text) out.push({ kind: "text", text, raw: m });
  } else if (t === "tool_call" || t === "tool_use" || t === "toolCall") {
    out.push({ kind: "tool_call", callId: m.id ?? m.callId ?? crypto.randomUUID(), tool: m.name ?? m.tool ?? m.toolName ?? "unknown", args: m.args ?? m.input ?? m.parameters ?? {}, raw: m });
  } else if (t === "tool_result" || t === "toolResult") {
    out.push({ kind: "tool_result", callId: m.id ?? m.callId ?? "", ok: !(m.error ?? m.isError), text: String(m.output ?? m.result ?? m.error ?? ""), raw: m });
  }
  const u = m.usage ?? m.usageMetadata ?? (t === "usage" ? m : undefined);
  if (u) out.push({ kind: "usage", tokensIn: u.input_tokens ?? u.promptTokenCount ?? u.promptTokens ?? 0, tokensOut: u.output_tokens ?? u.candidatesTokenCount ?? u.candidatesTokens ?? 0, raw: m });
  return out;
}
