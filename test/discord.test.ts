import { expect, it } from "vitest";
import { routeMessage, splitReply, type DiscordAccess, type DiscordEnvelope } from "../src/connectors/discord/routing.js";
import { readConfig } from "../src/config.js";

const open: DiscordAccess = { guildIds: new Set(), channelIds: new Set(), userIds: new Set(), allowDMs: true };
const message: DiscordEnvelope = { id: "1", channelId: "2", guildId: "3", parentId: null,
  isThread: false, authorId: "4", authorIsBot: false, webhookId: null, content: "<@99> Hello" };

it("accepts DMs and direct mentions, ignoring ambient messages, bots, and webhooks", () => {
  expect(routeMessage(message, "99", open)?.text).toBe("Hello");
  expect(routeMessage(message, "99", open)?.senderId).toBe("discord:4");
  expect(routeMessage({ ...message, content: "<@!99> Hello" }, "99", open)?.text).toBe("Hello");
  expect(routeMessage({ ...message, content: "hello" }, "99", open)).toBeUndefined();
  expect(routeMessage({ ...message, content: "<@991> hello" }, "99", open)).toBeUndefined();
  expect(routeMessage({ ...message, guildId: null, content: "hello" }, "99", open)).toBeDefined();
  expect(routeMessage({ ...message, authorIsBot: true }, "99", open)).toBeUndefined();
  expect(routeMessage({ ...message, webhookId: "5" }, "99", open)).toBeUndefined();
});

it("keeps DM, server, channel and thread sessions separate", () => {
  const key = (overrides: Partial<DiscordEnvelope>) => routeMessage({ ...message, ...overrides }, "99", open)!.conversationId;
  expect(key({})).not.toBe(key({ authorId: "5" }));
  expect(key({})).not.toBe(key({ guildId: null }));
  expect(key({})).not.toBe(key({ channelId: "6" }));
  expect(key({ isThread: true })).toBe(key({ isThread: true, authorId: "5" }));
});

it("enforces every configured allowlist, permits allowed parent threads, and controls DMs separately", () => {
  const restricted = { ...open, guildIds: new Set(["3"]), channelIds: new Set(["2"]), userIds: new Set(["4"]) };
  expect(routeMessage(message, "99", restricted)).toBeDefined();
  for (const overrides of [{ guildId: "8" }, { channelId: "8" }, { authorId: "8" }]) {
    expect(routeMessage({ ...message, ...overrides }, "99", restricted)).toBeUndefined();
  }
  expect(routeMessage({ ...message, channelId: "8", parentId: "2", isThread: true }, "99", restricted)).toBeDefined();
  expect(routeMessage({ ...message, guildId: null }, "99", restricted)).toBeDefined();
  expect(routeMessage({ ...message, guildId: null }, "99", { ...restricted, allowDMs: false })).toBeUndefined();
});

it("splits long replies without dropping content or breaking Unicode pairs", () => {
  const text = "a".repeat(1999) + "😀" + "b".repeat(2100);
  const chunks = splitReply(text);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every(chunk => chunk.length <= 2000 && chunk.isWellFormed())).toBe(true);
});

it("validates access configuration without silently opening malformed lists", () => {
  expect(readConfig({ DISCORD_BOT_TOKEN: "test" }).access.userIds.size).toBe(0);
  expect(() => readConfig({ DISCORD_BOT_TOKEN: "test", DISCORD_ALLOWED_USER_IDS: "name" })).toThrow();
  expect(() => readConfig({ DISCORD_BOT_TOKEN: "test", DISCORD_ALLOW_DMS: "no" })).toThrow();
});
