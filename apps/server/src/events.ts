import { randomUUID } from "node:crypto";
import type { ServerEvent } from "@email2api/shared";

export interface PublishedEvent {
  id: string;
  event: ServerEvent;
}

interface Subscription {
  accountId?: string;
  listener: (event: PublishedEvent) => void;
}

export class EventBroker {
  private readonly bootId = randomUUID();
  private readonly subscriptions = new Set<Subscription>();
  private sequence = 0;

  ready(): PublishedEvent {
    return {
      id: `${this.bootId}:${++this.sequence}`,
      event: { type: "ready", serverTime: new Date().toISOString() }
    };
  }

  publish(event: Exclude<ServerEvent, { type: "ready" }>): void {
    const published = { id: `${this.bootId}:${++this.sequence}`, event };
    for (const subscription of this.subscriptions) {
      if (subscription.accountId && "accountId" in event && subscription.accountId !== event.accountId) continue;
      subscription.listener(published);
    }
  }

  subscribe(listener: Subscription["listener"], accountId?: string): () => void {
    const subscription = { listener, ...(accountId ? { accountId } : {}) };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }

  get subscriberCount(): number {
    return this.subscriptions.size;
  }
}
