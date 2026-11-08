import { ChannelType, PermissionsBitField, PermissionFlagsBits, type Client, type Message } from "discord.js";
import { expect, it, vi } from "vitest";
import { createDiscordChatReader, snapshotMessages } from "../src/connectors/discord/chat-reader.js";

function chatMessage(id: string, content: string): Message {
  return { id, content, author: { id: "author", displayName: "Someone", bot: false }, attachments: { size: 0 },
    createdAt: new Date(Number(id) * 1000), createdTimestamp: Number(id) * 1000, url: `https://discord.com/channels/1/2/${id}` } as unknown as Message;
}
function setup({ userAllowed = true, botAllowed = true, privateThread = false, member = true } = {}) {
  const user = { id: "user" };
  const bot = { id: "bot" };
  const allowed = new PermissionsBitField(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory);
  const denied = new PermissionsBitField(PermissionFlagsBits.ViewChannel);
  const fetch = vi.fn(async () => new Map([["2", chatMessage("2", "newer")], ["1", chatMessage("1", "older")]]));
  const fetchPins = vi.fn(async () => ({ items: [{ message: chatMessage("1", "Pinned rule") }], hasMore: false }));
  const channel = { id: "channel", name: "guild-chat", type: privateThread ? ChannelType.PrivateThread : ChannelType.GuildText,
    isTextBased: () => true, isVoiceBased: () => false,
    guild: { members: { fetch: vi.fn(async () => user) } },
    permissionsFor: (who: { id: string }) => (who.id === "user" ? userAllowed : botAllowed) ? allowed : denied,
    members: { fetch: vi.fn(async () => { if (!member) throw new Error("not a member"); return {}; }) },
    messages: { fetch, fetchPins },
  };
  const channelsFetch = vi.fn(async () => channel);
  const client = { user: bot, channels: { fetch: channelsFetch } } as unknown as Client;
  return { reader: createDiscordChatReader({ client, channelId: "channel", userId: "user", beforeMessageId: "trigger" }),
    channel, fetch, fetchPins, channelsFetch };
}

it("reads only the fixed channel before the triggering message and returns chronological attribution", async () => {
  const { reader, fetch, channelsFetch } = setup();
  const result = await reader.recent(20, new AbortController().signal);
  expect(channelsFetch).toHaveBeenCalledWith("channel", { force: true });
  expect(fetch).toHaveBeenCalledWith({ limit: 20, before: "trigger", cache: false });
  expect(result).toMatchObject({ status: "ok", messages: [{ id: "1", text: "older", authorId: "author" }, { id: "2", text: "newer" }] });
});

it.each([{ userAllowed: false }, { botAllowed: false }, { privateThread: true, member: false }])(
  "denies reads when access is missing: %j", async options => {
    const { reader, fetch, fetchPins } = setup(options);
    expect(await reader.authorize(new AbortController().signal)).toBeTruthy();
    expect(await reader.recent(20, new AbortController().signal)).toMatchObject({ status: "denied" });
    expect(await reader.pins(new AbortController().signal)).toMatchObject({ status: "denied" });
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchPins).not.toHaveBeenCalled();
  },
);

it("rechecks permissions on every read and bounds pinned messages", async () => {
  const { reader, fetchPins, channel } = setup();
  expect(await reader.authorize(new AbortController().signal)).toBeUndefined();
  expect(await reader.pins(new AbortController().signal)).toMatchObject({ status: "ok", messages: [{ text: "Pinned rule" }] });
  expect(fetchPins).toHaveBeenCalledWith({ limit: 10, cache: false });
  channel.permissionsFor = () => new PermissionsBitField();
  expect(await reader.recent(20, new AbortController().signal)).toMatchObject({ status: "denied" });
});

it("handles a deleted channel without reading history or leaking raw API errors", async () => {
  const { reader, channelsFetch, fetch } = setup();
  channelsFetch.mockRejectedValueOnce(new Error("private API error details"));
  const reason = await reader.authorize(new AbortController().signal);
  expect(reason).toContain("could not verify");
  expect(reason).not.toContain("private API");
  expect(fetch).not.toHaveBeenCalled();
});

it("bounds retrieved text, prioritizes recent messages, and keeps Unicode intact", () => {
  const messages = Array.from({ length: 30 }, (_, index) => chatMessage(String(index + 1), "x".repeat(1999) + "😀"));
  const snapshots = snapshotMessages(messages);
  expect(snapshots.reduce((total, message) => total + message.text.length, 0)).toBeLessThanOrEqual(24_000);
  expect(snapshots.every(message => message.text.length <= 2000 && message.text.isWellFormed())).toBe(true);
  expect(snapshots.at(-1)?.text.length).toBeGreaterThan(0);
  expect(snapshots[0]?.text).toBe("");
  expect(messages[0]?.content.length).toBe(2001);
});
