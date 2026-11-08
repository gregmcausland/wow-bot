import type { ContextMessage, ConversationContext } from "./context.js";
import { emptyContext, hasCheckpoint } from "./context.js";
import { rateLimitReply } from "./rate-limit.js";
import { RequestQueue, RequestQueueFull } from "./request-queue.js";
import type { AgentEnvironment, ConversationEnvironment } from "./tools.js";

export interface ChatMessage { role: "user" | "assistant"; content: string }
export interface IncomingMessage {
  id: string;
  conversationId: string;
  senderId: string;
  text: string;
}
export interface AgentReply {
  text: string;
  context: ConversationContext;
  compactionCount: number;
}
export interface Agent {
  modelId: string;
  reply(messages: ContextMessage[], signal: AbortSignal, environment?: AgentEnvironment): Promise<AgentReply>;
}
export interface ConversationStore {
  load(id: string): ConversationContext;
  hasProcessed(id: string): boolean;
  markProcessed(id: string): void;
  takeUserSlot(userId: string, messageId: string, now: number): number;
  save(id: string, messageId: string, context: ConversationContext, transcript: ChatMessage[] | null): void;
}

export class Conversations {
  private readonly queue = new RequestQueue();
  private readonly inFlight = new Set<string>();
  constructor(private readonly agent: Agent, private readonly store: ConversationStore,
    private readonly now: () => number = Date.now) {}

  async handle(message: IncomingMessage, send: (text: string) => Promise<void>, environment: ConversationEnvironment = {}): Promise<void> {
    if (this.inFlight.has(message.id) || this.store.hasProcessed(message.id)) return;
    this.inFlight.add(message.id);
    try {
      const wait = this.store.takeUserSlot(message.senderId, message.id, this.now());
      if (wait > 0) {
        await send(rateLimitReply(wait));
        this.store.markProcessed(message.id);
        return;
      }
      try { await this.queue.run(message.conversationId, () => this.respond(message, send, environment)); }
      catch (error) {
        if (!(error instanceof RequestQueueFull)) throw error;
        await send("I’m busy with a few requests. Please try again shortly.");
        this.store.markProcessed(message.id);
      }
    } finally { this.inFlight.delete(message.id); }
  }

  async drain() { await this.queue.drain(); }

  private async respond(message: IncomingMessage, send: (text: string) => Promise<void>, environment: ConversationEnvironment) {
    if (!message.text.trim() || message.text.length > 12_000) {
      await send(message.text.trim()
        ? "Please shorten your message to 12,000 characters or fewer."
        : "Send me a question or paste the text you’d like help with. Attachments aren’t supported yet.");
      this.store.markProcessed(message.id);
      return;
    }
    if (environment.chat) {
      const denial = await environment.chat.authorize(AbortSignal.timeout(10_000));
      if (denial) {
        await send(`Mrrgl, Holmes cannot use this chat's history here. ${denial}`);
        this.store.markProcessed(message.id);
        return;
      }
    }
    if (message.text.trim().toLowerCase() === "reset") {
      await send("Conversation reset.");
      this.store.save(message.conversationId, message.id, emptyContext(), null);
      return;
    }
    const history = this.store.load(message.conversationId);
    if (history.model && history.model !== this.agent.modelId && hasCheckpoint(history.messages)) {
      await send("Holmes model changed, but old memory belongs to previous model. Send `reset` to start fresh; the conversation archive is preserved.");
      this.store.markProcessed(message.id);
      return;
    }
    const user: ChatMessage = { role: "user", content: `Sender ID: ${message.senderId}\n\n${message.text}` };
    environment.onModelStart?.();
    const result = await this.agent.reply([...history.messages, user], AbortSignal.timeout(90_000), environment);
    const reply = result.text.trim();
    if (!reply) throw new Error("Agent returned an empty response.");
    await send(reply);
    this.store.save(message.conversationId, message.id, result.context, [user, { role: "assistant", content: reply }]);
  }
}
