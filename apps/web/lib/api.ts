export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface SessionRow {
  id: string; title: string; created_at: string; updated_at: string;
  props: { state?: string; vendor?: string; runnerId?: string; spendGbp?: number; tokensIn?: number; tokensOut?: number; lastEvent?: string; parkedCallId?: string; parkedGap?: string; outcome?: string; startedAt?: string; workflowId?: string };
}

export async function getSessions(): Promise<SessionRow[]> {
  const r = await fetch(`${API}/sessions`, { cache: "no-store" });
  return (await r.json()).sessions;
}
export async function startTask(body: unknown) {
  const r = await fetch(`${API}/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
export async function approve(sessionId: string, callId: string, mode: "once" | "widen" | "deny") {
  await fetch(`${API}/approvals/${callId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, mode }) });
}
export async function cancelSession(id: string) {
  await fetch(`${API}/sessions/${id}/cancel`, { method: "POST" });
}

export const get = async <T,>(path: string): Promise<T> => (await fetch(`${API}${path}`, { cache: "no-store" })).json();
export const post = async <T,>(path: string, body?: unknown): Promise<T> => (await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();
