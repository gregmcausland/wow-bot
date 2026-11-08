import { Client, Events, GatewayIntentBits, Partials, type Message } from "discord.js";
import type { Conversations } from "../../core/conversation.js";
import { routeMessage, type DiscordAccess } from "./routing.js";
import { createDiscordChatReader } from "./chat-reader.js";
import { DiscordReply } from "./reply.js";

export function createDiscordConnector(conversations: Conversations, access: DiscordAccess) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
    rest: { timeout: 10_000, retries: 0 },
    partials: [Partials.Channel],
    allowedMentions: { parse: [], repliedUser: false },
  });
  let stopping = false;
  client.on(Events.Error, () => console.error("Discord connection error."));
  client.on(Events.ShardError, () => console.error("Discord gateway error; reconnecting."));
  client.once(Events.ClientReady, ready => console.info(`Discord connected as ${ready.user.tag}.`));

  async function receive(message: Message) {
    if (stopping || !client.user) return;
    const incoming = routeMessage({
      id: message.id, channelId: message.channelId, guildId: message.guildId,
      parentId: message.channel.isThread() ? message.channel.parentId : null,
      isThread: message.channel.isThread(), authorId: message.author.id,
      authorIsBot: message.author.bot, webhookId: message.webhookId, content: message.content,
    }, client.user.id, access);
    if (!incoming) return;
    if (!message.channel.isSendable()) return;
    const channel = message.channel;
    const allowedMentions = { parse: [] as [], repliedUser: false };
    const delivery = new DiscordReply({
      reply: async content => {
        const reply = await message.reply({ content, allowedMentions });
        return { edit: async content => { await reply.edit({ content, allowedMentions }); } };
      },
      followup: async content => { await channel.send({ content, allowedMentions }); },
    });
    const typing = () => { if ("sendTyping" in channel) void channel.sendTyping().catch(() => {}); };
    typing();
    const timer = setInterval(typing, 8000);
    try {
      await conversations.handle(incoming, text => delivery.send(text), {
        chat: createDiscordChatReader({ client, channelId: message.channelId, userId: message.author.id, beforeMessageId: message.id }),
        onModelStart: () => delivery.start(),
        onWorking: () => delivery.working(),
      });
    } catch {
      console.error("Conversation failed", { messageId: message.id, channelId: message.channelId });
      await delivery.send("I couldn’t complete that request. Please try again. If it keeps failing, check the bot’s connection and OAuth login.").catch(() => {});
    } finally { clearInterval(timer); delivery.close(); }
  }
  client.on(Events.MessageCreate, message => { void receive(message).catch(() => console.error("Discord message handling failed.")); });
  return {
    async start(token: string) { await client.login(token); },
    async stop() {
      stopping = true;
      await conversations.drain();
      await client.destroy();
    },
  };
}
