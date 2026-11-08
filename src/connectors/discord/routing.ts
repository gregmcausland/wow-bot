import type { IncomingMessage } from "../../core/conversation.js";

export interface DiscordAccess {
  guildIds: ReadonlySet<string>;
  channelIds: ReadonlySet<string>;
  userIds: ReadonlySet<string>;
  allowDMs: boolean;
}
export interface DiscordEnvelope {
  id: string;
  channelId: string;
  guildId: string | null;
  parentId: string | null;
  isThread: boolean;
  authorId: string;
  authorIsBot: boolean;
  webhookId: string | null;
  content: string;
}

export function routeMessage(message: DiscordEnvelope, botId: string, access: DiscordAccess): IncomingMessage | undefined {
  if (message.authorIsBot || message.webhookId) return;
  if (access.userIds.size && !access.userIds.has(message.authorId)) return;
  const dm = message.guildId === null;
  if (dm) {
    if (!access.allowDMs) return;
  } else {
    if (access.guildIds.size && !access.guildIds.has(message.guildId!)) return;
    if (access.channelIds.size && !access.channelIds.has(message.channelId)
      && !(message.isThread && message.parentId && access.channelIds.has(message.parentId))) return;
    if (!new RegExp(`<@!?${botId}>`).test(message.content)) return;
  }
  // Server threads share context; ordinary channel mentions are private to each sender's session.
  const session = dm || message.isThread ? message.channelId : `${message.channelId}:${message.authorId}`;
  return {
    id: `discord:${message.id}`,
    conversationId: `discord:${message.guildId ?? "dm"}:${session}`,
    senderId: `discord:${message.authorId}`,
    text: message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim(),
  };
}

export function splitReply(text: string): string[] {
  const chunks: string[] = [];
  while (text.length > 2000) {
    let end = text.lastIndexOf("\n", 2000);
    if (end < 1000) end = 2000;
    // Avoid splitting a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) chunks.push(text);
  return chunks;
}
