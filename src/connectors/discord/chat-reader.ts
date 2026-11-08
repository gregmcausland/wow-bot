import { ChannelType, PermissionFlagsBits, type Client, type Message } from "discord.js";
import type { ChatReader, ChatReadResult, ChatSnapshot } from "../../core/tools.js";

interface ChatScope { client: Client; channelId: string; userId: string; beforeMessageId: string }

export function snapshotMessages(messages: Message[]): ChatSnapshot[] {
  let remaining = 24_000;
  // Prefer newer text when a long channel history exceeds the tool budget.
  return [...messages].reverse().map(message => {
    let end = Math.min(2000, remaining, message.content.length);
    if (/[\uD800-\uDBFF]/.test(message.content[end - 1] ?? "")) end--;
    const text = message.content.slice(0, end);
    remaining -= text.length;
    return { id: message.id, authorId: message.author.id,
      authorName: message.author.displayName.slice(0, 80), text,
      createdAt: message.createdAt.toISOString(), url: message.url,
      truncated: text.length < message.content.length, authorIsBot: message.author.bot,
      attachmentsOmitted: message.attachments.size > 0 };
  }).reverse();
}

export function createDiscordChatReader(scope: ChatScope): ChatReader {
  async function readable(signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      // Resolve the fixed channel afresh; the model never supplies a channel ID.
      const channel = await scope.client.channels.fetch(scope.channelId, { force: true });
      if (!channel?.isTextBased()) return { status: "unavailable" as const, reason: "The current chat is unavailable." };
      if ("guild" in channel) {
        const member = await channel.guild.members.fetch({ user: scope.userId, force: true });
        const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory
          | (channel.isVoiceBased() ? PermissionFlagsBits.Connect : 0n);
        if (!channel.permissionsFor(member)?.has(required) || !scope.client.user
          || !channel.permissionsFor(scope.client.user)?.has(required)) {
          return { status: "denied" as const, reason: "Both you and Holmes need permission to view this channel and read its message history." };
        }
        if (channel.type === ChannelType.PrivateThread && !channel.permissionsFor(member)?.has(PermissionFlagsBits.ManageThreads)) {
          const membership = await channel.members.fetch({ member: scope.userId, force: true }).catch(() => null);
          if (!membership) return { status: "denied" as const, reason: "You must be a member of this private thread to read its context." };
        }
      }
      signal.throwIfAborted();
      return { status: "ok" as const, channel };
    } catch {
      signal.throwIfAborted();
      return { status: "unavailable" as const, reason: "Discord could not verify your access to this chat. Please try again shortly." };
    }
  }
  async function read(kind: "recent" | "pins", limit: number, signal: AbortSignal): Promise<ChatReadResult> {
    const access = await readable(signal);
    if (access.status !== "ok") return access;
    const channel = access.channel;
    try {
      const recent = kind === "recent" ? await channel.messages.fetch({ limit, before: scope.beforeMessageId, cache: false }) : null;
      const pins = kind === "pins" ? await channel.messages.fetchPins({ limit: 10, cache: false }) : null;
      signal.throwIfAborted();
      const messages = (recent ? [...recent.values()] : pins!.items.map(item => item.message))
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      return { status: "ok", channelId: channel.id, channelName: "name" in channel ? channel.name ?? "DM" : "DM",
        messages: snapshotMessages(messages), hasMore: recent ? recent.size === limit : pins!.hasMore };
    } catch {
      signal.throwIfAborted();
      console.error("Discord context read failed", { channelId: scope.channelId });
      return { status: "unavailable", reason: "Discord could not provide this chat's messages. Check channel permissions and Message Content access." };
    }
  }
  return {
    authorize: async signal => { const access = await readable(signal); return access.status === "ok" ? undefined : access.reason; },
    recent: (limit, signal) => read("recent", limit, signal), pins: signal => read("pins", 10, signal),
  };
}
