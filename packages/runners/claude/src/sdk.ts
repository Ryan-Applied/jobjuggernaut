/**
 * Thin seam over @anthropic-ai/claude-agent-sdk. Everything the adapter needs
 * from the SDK goes through here so a version bump is a one-file change.
 *
 * Streaming-input mode: the prompt is an async iterable of user messages, so the
 * session stays open for follow-ups until the iterable ends (B1).
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

export type SdkMessage =
  | { kind: "assistant"; text: string; tokensIn: number; tokensOut: number; subagentId?: string; raw: unknown }
  | { kind: "delta"; text: string; raw: unknown }
  | { kind: "tool_result"; callId: string; ok: boolean; summary: string; bytes: number; raw: unknown }
  | { kind: "turn_done"; tokensIn: number; tokensOut: number; costUsd: number; raw: unknown }
  | { kind: "other"; raw: unknown };

export interface RunQueryOptions {
  prompt: string;
  systemPrompt?: string;
  cwd: string;
  signal: AbortSignal;
  /** When set, the session stays open and reads follow-ups from this queue until it is closed. */
  followUps?: AsyncIterable<string>;
  partials?: boolean;
  /** Return true to let the tool run, false to block it. */
  onToolUse: (tool: string, args: Record<string, unknown>, callId: string, subagentId?: string) => Promise<boolean>;
}

async function* userMessages(first: string, followUps?: AsyncIterable<string>) {
  const msg = (content: string) => ({ type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null, session_id: "" });
  yield msg(first);
  if (followUps) for await (const t of followUps) yield msg(t);
}

export async function* runQuery(o: RunQueryOptions): AsyncIterable<SdkMessage> {
  const stream = query({
    prompt: o.followUps ? (userMessages(o.prompt, o.followUps) as any) : o.prompt,
    options: {
      cwd: o.cwd,
      systemPrompt: o.systemPrompt,
      permissionMode: "default",
      includePartialMessages: !!o.partials,
      abortController: controllerFrom(o.signal),
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const ok = await o.onToolUse(input.tool_name, input.tool_input ?? {}, input.tool_use_id ?? crypto.randomUUID(), input.parent_tool_use_id ?? undefined);
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ok ? "allow" : "deny", permissionDecisionReason: ok ? "grant matched" : "Blocked by policy: no grant covers this call" } };
          }],
        }],
      },
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
      if (!text && !(u.input_tokens || u.output_tokens)) continue;
      yield { kind: "assistant", text, tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0, subagentId: m.parent_tool_use_id ?? undefined, raw: m };
    } else if (m?.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
      yield { kind: "delta", text: m.event.delta.text, raw: undefined };
    } else if (m?.type === "user" && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) if (c.type === "tool_result")
        yield { kind: "tool_result", callId: c.tool_use_id, ok: !c.is_error, summary: summarise(c.content), bytes: JSON.stringify(c.content ?? "").length, raw: c };
    } else if (m?.type === "result") {
      yield { kind: "turn_done", tokensIn: m.usage?.input_tokens ?? 0, tokensOut: m.usage?.output_tokens ?? 0, costUsd: m.total_cost_usd ?? 0, raw: m };
    } else yield { kind: "other", raw: m };
  }
}

function summarise(content: unknown): string {
  const s = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => c.text ?? "").join("\n") : JSON.stringify(content ?? "");
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}
function controllerFrom(signal: AbortSignal) {
  const c = new AbortController();
  if (signal.aborted) c.abort(); else signal.addEventListener("abort", () => c.abort(), { once: true });
  return c;
}
