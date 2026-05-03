import type { Event, EventQuery } from "../types.ts";

let eventSeq = 0;

export class EventLog {
  private readonly events: Event[] = [];
  private readonly listeners = new Set<(event: Event) => void>();

  append(event: Omit<Event, "id" | "timestamp"> & { timestamp?: string }): Event {
    const fullEvent: Event = {
      id: `evt_${++eventSeq}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...event
    };
    this.events.push(fullEvent);
    for (const listener of this.listeners) {
      listener(fullEvent);
    }
    return fullEvent;
  }

  query(query: EventQuery = {}): Event[] {
    return this.events.filter((event) => {
      if (query.runId && event.runId !== query.runId) return false;
      if (query.pid && event.pid !== query.pid) return false;
      if (query.type && event.type !== query.type) return false;
      return true;
    });
  }

  all(): Event[] {
    return [...this.events];
  }

  replay(runId: string): Event[] {
    return this.query({ runId });
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
