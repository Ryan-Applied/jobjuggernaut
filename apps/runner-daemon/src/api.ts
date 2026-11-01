import type { SessionEvent, Grant } from "@jj/core";
import { createHash } from "node:crypto";

export interface ApiLike {
  postEvents(events: SessionEvent[]): Promise<void>;
  fetchGrants(ids: string[]): Promise<Grant[]>;
  audit(row: { sessionId: string; tool: string; args: Record<string, unknown>; decision: string; grantId?: string; decidedBy: string }): Promise<void>;
}

export class ApiClient implements ApiLike {
  constructor(private base = process.env.API_URL ?? "http://localhost:4000", private token = process.env.RUNNER_API_TOKEN ?? "dev-token") {}
  private headers() { return { "content-type": "application/json", authorization: `Bearer ${this.token}` }; }

  async postEvents(events: SessionEvent[]) {
    const r = await fetch(`${this.base}/events`, { method: "POST", headers: this.headers(), body: JSON.stringify({ events }) });
    if (!r.ok) throw new Error(`postEvents ${r.status}`);
  }
  async fetchGrants(ids: string[]): Promise<Grant[]> {
    const r = await fetch(`${this.base}/grants?ids=${ids.join(",")}`, { headers: this.headers() });
    if (!r.ok) throw new Error(`fetchGrants ${r.status}`);
    return (await r.json()).grants;
  }
  async audit(row: { sessionId: string; tool: string; args: Record<string, unknown>; decision: string; grantId?: string; decidedBy: string }) {
    const argsHash = createHash("sha256").update(JSON.stringify(row.args)).digest("hex").slice(0, 16);
    await fetch(`${this.base}/audit`, { method: "POST", headers: this.headers(), body: JSON.stringify({ ...row, args: undefined, argsHash }) }).catch(() => undefined);
  }
}
