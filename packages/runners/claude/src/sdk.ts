/**
 * Thin seam over @anthropic-ai/claude-agent-sdk. Everything the adapter needs
 * from the SDK goes through here so a version bump is a one-file change.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

export type SdkMessage =
  | { kind: "assistant"; text: string; tokensIn: number; tokensOut: number; raw: unknown }
  | { kind: "tool_result"; callId: string; ok: boolean; summary: string; bytes: number; raw: unknown }
  | { kind: "cost"; tokensIn: number; tokensOut: number; costGbp: number; raw: unknown }
  | { kind: "other"; raw: unknown };

export interface RunQueryOptions {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  signal: AbortSignal;
  /** Return true to let the tool run, false to block it. */
  onToolUse: (tool: string, args: Record<string, unknown>, callId: string) => Promise<boolean>;
}

export async function* runQuery(o: RunQueryOptions): AsyncIterable<SdkMessage> {
  const stream = query({
    prompt: o.prompt,
    options: {
      cwd: o.cwd,
      systemPrompt: o.systemPrompt,
      permissionMode: "default",
      abortController: controllerFrom(o.signal),
      // The interceptor: every tool use passes through here before it runs.
      canUseTool: async (toolName: string, input: Record<string, unknown>, ctx: { toolUseId?: string }) => {
        const ok = await o.onToolUse(toolName, input, ctx.toolUseId ?? crypto.randomUUID());
        return ok ? { behavior: "allow" as const, updatedInput: input } : { behavior: "deny" as const, message: "Blocked by policy: no grant covers this call" };
      },
    } as never,
  }) as AsyncIterable<any>;

  for await (const m of stream) {
    if (m?.type === "assistant") {
      const text = (m.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      const u = m.message?.usage ?? {};
      yield { kind: "assistant", text, tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0, raw: m };
    } else if (m?.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) if (c.type === "tool_result")
        yield { kind: "tool_result", callId: c.tool_use_id, ok: !c.is_error, summary: summarise(c.content), bytes: JSON.stringify(c.content ?? "").length, raw: c };
    } else if (m?.type === "result") {
      yield { kind: "cost", tokensIn: m.usage?.input_tokens ?? 0, tokensOut: m.usage?.output_tokens ?? 0, costGbp: (m.total_cost_usd ?? 0) * 0.78, raw: m };
    } else yield { kind: "other", raw: m };
  }
}

function summarise(content: unknown): string {
  const s = typeof content === "string" ? content : JSON.stringify(content ?? "");
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}
function controllerFrom(signal: AbortSignal) {
  const c = new AbortController();
  if (signal.aborted) c.abort(); else signal.addEventListener("abort", () => c.abort(), { once: true });
  return c;
}
