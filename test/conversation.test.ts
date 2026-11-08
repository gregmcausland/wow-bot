import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { Conversations, type AgentReply, type IncomingMessage } from "../src/core/conversation.js";
import { emptyContext, type ContextMessage } from "../src/core/context.js";
import { SqliteConversationStore } from "../src/core/store.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function database() {
  const directory = mkdtempSync(join(tmpdir(), "wow-bot-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "chat.sqlite");
  const store = new SqliteConversationStore(path);
  cleanup.push(() => store.close());
  return { path, store };
}
function answer(messages: ContextMessage[], text = "Hi"): AgentReply {
  return { text, context: { version: 1, model: "test", messages: [...messages, { role: "assistant", content: text }] }, compactionCount: 0 };
}
const message: IncomingMessage = { id: "1", conversationId: "discord:dm:1", senderId: "user", text: "Hello" };

it("persists context across reopen, isolates sessions, and skips delivered duplicates", async () => {
  const { path, store } = database();
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const send = vi.fn(async () => {});
  const conversations = new Conversations({ modelId: "test", reply }, store);
  await conversations.handle(message, send);
  const reopened = new SqliteConversationStore(path);
  cleanup.push(() => reopened.close());
  const next = new Conversations({ modelId: "test", reply }, reopened);
  await next.handle(message, send);
  expect(reply).toHaveBeenCalledTimes(1);
  await next.handle({ ...message, id: "2", text: "Remember?" }, send);
  expect(reply.mock.calls[1]![0]).toHaveLength(3);
  await next.handle({ ...message, id: "3", conversationId: "other" }, send);
  expect(reply.mock.calls[2]![0]).toHaveLength(1);
});

it("serializes one conversation while other conversations can progress", async () => {
  const { store } = database();
  let finish!: () => void;
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages, "other reply"))
    .mockImplementationOnce(messages => new Promise(resolve => { finish = () => resolve(answer(messages, "first reply")); }));
  const conversations = new Conversations({ modelId: "test", reply }, store);
  const send = vi.fn(async () => {});
  const first = conversations.handle(message, send);
  const second = conversations.handle({ ...message, id: "2" }, send);
  await conversations.handle({ ...message, id: "3", conversationId: "other" }, send);
  expect(reply).toHaveBeenCalledTimes(2);
  finish();
  await Promise.all([first, second]);
  expect(reply.mock.calls[2]![0][1]).toEqual({ role: "assistant", content: "first reply" });
});

it("keeps failures out of history and permits the next turn", async () => {
  const { store } = database();
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages)).mockRejectedValueOnce(new Error("upstream failed"));
  const conversations = new Conversations({ modelId: "test", reply }, store);
  const send = vi.fn(async () => {});
  await expect(conversations.handle(message, send)).rejects.toThrow("upstream failed");
  expect(store.load(message.conversationId)).toEqual(emptyContext());
  expect(store.hasProcessed(message.id)).toBe(false);
  await conversations.handle({ ...message, id: "2" }, send);
  expect(store.load(message.conversationId).messages).toHaveLength(2);
});

it("does not commit an undelivered answer and resets only the current model context", async () => {
  const { path, store } = database();
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const conversations = new Conversations({ modelId: "test", reply }, store);
  await expect(conversations.handle(message, async () => { throw new Error("delivery failed"); })).rejects.toThrow();
  expect(store.hasProcessed(message.id)).toBe(false);
  await conversations.handle(message, async () => {});
  await conversations.handle({ ...message, id: "2", text: "reset" }, async () => {});
  expect(store.load(message.conversationId)).toEqual(emptyContext());
  const db = new DatabaseSync(path);
  expect(db.prepare("SELECT event FROM transcript ORDER BY sequence").all()).toEqual([{ event: "turn" }, { event: "reset" }]);
  db.close();
  expect(reply).toHaveBeenCalledTimes(2);
});

it("limits a user across conversations and DMs without model calls or extending the wait", async () => {
  const { store } = database();
  let now = 100_000;
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const conversations = new Conversations({ modelId: "test", reply }, store, () => now);
  const send = vi.fn(async () => {});
  for (let i = 0; i < 5; i++) {
    await conversations.handle({ ...message, id: String(i), conversationId: `room-${i}` }, send);
    now += 1000;
  }
  await conversations.handle({ ...message, id: "blocked", conversationId: "dm" }, send);
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("55 seconds"));
  expect(reply).toHaveBeenCalledTimes(5);
  now = 159_999;
  await conversations.handle({ ...message, id: "blocked-2" }, send);
  expect(send).toHaveBeenLastCalledWith(expect.stringContaining("1 second!"));
  now = 160_000;
  await conversations.handle({ ...message, id: "allowed-again" }, send);
  expect(reply).toHaveBeenCalledTimes(6);
});

it("allows other users and persists a user's limit through restarts", async () => {
  const { path, store } = database();
  for (let i = 0; i < 5; i++) expect(store.takeUserSlot("user", String(i), 100_000)).toBe(0);
  const reopened = new SqliteConversationStore(path);
  cleanup.push(() => reopened.close());
  expect(reopened.takeUserSlot("user", "six", 110_000)).toBe(50);
  expect(reopened.takeUserSlot("other", "other-message", 110_000)).toBe(0);
  expect(reopened.takeUserSlot("user", "zero-attempt", 160_000)).toBe(0);
});

it("deduplicates messages while queued without charging or answering twice", async () => {
  const { store } = database();
  let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const reply = vi.fn(async (messages: ContextMessage[]) => { await block; return answer(messages); });
  const conversations = new Conversations({ modelId: "test", reply }, store);
  const send = vi.fn(async () => {});
  const first = conversations.handle(message, send);
  await conversations.handle(message, send);
  release();
  await first;
  expect(reply).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledTimes(1);
});

it("migrates old text history once and preserves it in the archive", () => {
  const { path, store } = database();
  const db = new DatabaseSync(path);
  const legacy = [{ role: "user", content: "My old fact" }, { role: "assistant", content: "Remembered" }];
  db.prepare("INSERT INTO conversations VALUES (?, ?)").run("legacy", JSON.stringify(legacy));
  const migrated = new SqliteConversationStore(path);
  cleanup.push(() => migrated.close());
  expect(migrated.load("legacy").messages).toEqual(legacy);
  expect(db.prepare("SELECT event, messages FROM transcript").all()).toEqual([{ event: "import", messages: JSON.stringify(legacy) }]);
  const reopened = new SqliteConversationStore(path);
  cleanup.push(() => reopened.close());
  expect(db.prepare("SELECT COUNT(*) AS count FROM transcript").get()?.count).toBe(1);
  db.close();
  expect(store.load("legacy").messages).toEqual(legacy);
});

it("rolls back context and transcript together if the commit fails", () => {
  const { path, store } = database();
  store.markProcessed("duplicate");
  expect(() => store.save("room", "duplicate", { version: 1, model: "test", messages: [{ role: "user", content: "new" }] },
    [{ role: "user", content: "new" }])).toThrow();
  expect(store.load("room")).toEqual(emptyContext());
  const db = new DatabaseSync(path);
  expect(db.prepare("SELECT COUNT(*) AS count FROM transcript").get()?.count).toBe(0);
  db.close();
});

it("keeps a mismatched model checkpoint intact and asks for reset without inference", async () => {
  const { store } = database();
  const context = { version: 1 as const, model: "previous-model", messages: [{ role: "assistant" as const, content: [{
    type: "custom" as const, kind: "openai.compaction" as const,
    providerOptions: { openai: { type: "compaction" as const, itemId: "checkpoint", encryptedContent: "opaque" } },
  }] }] };
  store.save("room", "seed", context, []);
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const send = vi.fn(async () => {});
  await new Conversations({ modelId: "test", reply }, store).handle({ ...message, conversationId: "room" }, send);
  expect(reply).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledWith(expect.stringContaining("reset"));
  expect(store.load("room")).toEqual(context);
});

it("does not let reset bypass the user's quota", async () => {
  const { store } = database();
  for (let i = 0; i < 5; i++) store.takeUserSlot("user", `prior-${i}`, 100_000);
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const send = vi.fn(async () => {});
  await new Conversations({ modelId: "test", reply }, store, () => 101_000)
    .handle({ ...message, text: "reset" }, send);
  expect(send).toHaveBeenCalledWith(expect.stringContaining("59 seconds"));
  expect(reply).not.toHaveBeenCalled();
});

it("checks current access before exposing saved shared history or starting a working reply", async () => {
  const { store } = database();
  const reply = vi.fn(async (messages: ContextMessage[]) => answer(messages));
  const onModelStart = vi.fn();
  const send = vi.fn(async () => {});
  const chat = { authorize: vi.fn(async () => "Message history permission is required."), recent: vi.fn(), pins: vi.fn() };
  await new Conversations({ modelId: "test", reply }, store).handle(message, send, { chat, onModelStart });
  expect(send).toHaveBeenCalledWith(expect.stringContaining("permission"));
  expect(reply).not.toHaveBeenCalled();
  expect(onModelStart).not.toHaveBeenCalled();
});
