import type { SessionEvent } from "@jj/core";

/** In-process fan-out with a replay buffer so SSE clients can reconnect from a cursor. */
export class EventBus {
  private buffer: Array<{ cursor: number; event: SessionEvent }> = [];
  private cursor = 0;
  private subs = new Set<(cursor: number, e: SessionEvent) => void>();
  constructor(private max = 5000) {}

  publish(e: SessionEvent) {
    const cursor = ++this.cursor;
    this.buffer.push({ cursor, event: e });
    if (this.buffer.length > this.max) this.buffer.shift();
    for (const s of this.subs) s(cursor, e);
    return cursor;
  }
  since(cursor: number) { return this.buffer.filter((b) => b.cursor > cursor); }
  subscribe(fn: (cursor: number, e: SessionEvent) => void) { this.subs.add(fn); return () => this.subs.delete(fn); }
}
