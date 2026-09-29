/** Cross-tab coordination over BroadcastChannel (same-origin, in-browser only). */
import { makeId } from '@/lib/hash';

export type TabMessage =
  | { type: 'saved'; docId: string; version: number; tabId: string }
  | { type: 'meta'; docId: string; tabId: string }
  | { type: 'deleted'; docId: string; tabId: string }
  | { type: 'restored'; docId: string; tabId: string }
  | { type: 'created'; docId: string; tabId: string }
  | { type: 'settings'; tabId: string };

type Payload = TabMessage extends infer T ? (T extends TabMessage ? Omit<T, 'tabId'> : never) : never;

export class TabSync {
  readonly tabId = makeId('t');
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(m: TabMessage) => void>();

  constructor(name = 'inkwell') {
    if (typeof BroadcastChannel === 'undefined') return;
    this.channel = new BroadcastChannel(name);
    this.channel.onmessage = (e: MessageEvent<TabMessage>) => {
      if (!e.data || e.data.tabId === this.tabId) return;
      for (const fn of this.listeners) fn(e.data);
    };
  }

  post(message: Payload): void {
    this.channel?.postMessage({ ...message, tabId: this.tabId });
  }

  subscribe(fn: (m: TabMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}
