/**
 * Structured LLM calls. One interface, two implementations:
 *  - AnthropicLLM: tool-use forced to a JSON schema, so the output always parses.
 *  - MockLLM: deterministic drafts from the facts alone, for tests and JJ_MOCK_RUNNER.
 * Runs on the runner host, where the key lives. Nothing here touches the network otherwise.
 */
import type { ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "./zod-json.js";

export interface LLM {
  name: string;
  structured<S extends ZodTypeAny>(opts: { system: string; user: string; schema: S; schemaName: string; maxTokens?: number }): Promise<z.output<S>>;
}

export class AnthropicLLM implements LLM {
  name: string;
  private client: any;
  constructor(private model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6") { this.name = `anthropic:${this.model}`; }
  private async c() { if (!this.client) { const { default: Anthropic } = await import("@anthropic-ai/sdk"); this.client = new Anthropic(); } return this.client; }
  async structured<S extends ZodTypeAny>({ system, user, schema, schemaName, maxTokens = 4000 }: { system: string; user: string; schema: S; schemaName: string; maxTokens?: number }): Promise<z.output<S>> {
    const client = await this.c();
    const res = await client.messages.create({
      model: this.model, max_tokens: maxTokens, system,
      tools: [{ name: schemaName, description: `Return the ${schemaName}.`, input_schema: zodToJsonSchema(schema) }],
      tool_choice: { type: "tool", name: schemaName },
      messages: [{ role: "user", content: user }],
    });
    const block = res.content.find((b: any) => b.type === "tool_use");
    if (!block) throw new Error("no structured output from model");
    return schema.parse(block.input);
  }
}

export class MockLLM implements LLM {
  name = "mock";
  constructor(private answer: (schemaName: string, user: string) => unknown) {}
  async structured<S extends ZodTypeAny>({ user, schema, schemaName }: { user: string; schema: S; schemaName: string }): Promise<z.output<S>> {
    return schema.parse(this.answer(schemaName, user));
  }
}

export function defaultLLM(mock: boolean): LLM | undefined {
  if (mock) return undefined;
  return process.env.ANTHROPIC_API_KEY ? new AnthropicLLM() : undefined;
}
