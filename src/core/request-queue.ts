export class RequestQueueFull extends Error {}

const MAX_ACTIVE_REQUESTS = 2;
const MAX_PENDING_REQUESTS = 16;
const MAX_PENDING_PER_CONVERSATION = 4;

export class RequestQueue {
  private readonly conversations = new Map<string, { tail: Promise<void>; count: number }>();
  private readonly slots: (() => void)[] = [];
  private active = 0;
  private pending = 0;

  run(key: string, task: () => Promise<void>): Promise<void> {
    const conversation = this.conversations.get(key) ?? { tail: Promise.resolve(), count: 0 };
    if (this.pending >= MAX_PENDING_REQUESTS || conversation.count >= MAX_PENDING_PER_CONVERSATION) {
      return Promise.reject(new RequestQueueFull());
    }
    this.pending++;
    conversation.count++;
    const current = conversation.tail.catch(() => {}).then(async () => {
      await this.acquire();
      try { await task(); }
      finally {
        const next = this.slots.shift();
        if (next) next();
        else this.active--;
      }
    }).finally(() => {
      this.pending--;
      conversation.count--;
      if (!conversation.count) this.conversations.delete(key);
    });
    conversation.tail = current;
    this.conversations.set(key, conversation);
    return current;
  }

  private async acquire() {
    if (this.active < MAX_ACTIVE_REQUESTS) { this.active++; return; }
    await new Promise<void>(resolve => { this.slots.push(resolve); });
  }

  async drain() { await Promise.allSettled([...this.conversations.values()].map(value => value.tail)); }
}
