import type { TunnelEvent } from "@xistance/types";

type Listener = (event: TunnelEvent) => void;

/**
 * In-process event bus. The web layer subscribes to drive Server-Sent Events;
 * the engine publishes status/traffic/log events as they happen.
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(tunnelId: string, fn: Listener): () => void {
    let set = this.listeners.get(tunnelId);
    if (!set) {
      set = new Set();
      this.listeners.set(tunnelId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(tunnelId);
    };
  }

  publish(tunnelId: string, event: TunnelEvent): void {
    const set = this.listeners.get(tunnelId);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch {
        // Never let a subscriber break dispatch.
      }
    }
  }

  /** Number of active subscribers for a tunnel (used to gate work). */
  count(tunnelId: string): number {
    return this.listeners.get(tunnelId)?.size ?? 0;
  }
}

export type { Listener };

export const globalBus = new EventBus();