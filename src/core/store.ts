import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { contextSchema, emptyContext, type ConversationContext } from "./context.js";
import { USER_MESSAGES_PER_MINUTE, USER_RATE_WINDOW_MS } from "./rate-limit.js";
import type { ConversationStore, ChatMessage } from "./conversation.js";

const legacyHistorySchema = z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }));

export class SqliteConversationStore implements ConversationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS processed_messages (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        event TEXT NOT NULL, messages TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_conversation ON transcript(conversation_id, sequence);
      CREATE TABLE IF NOT EXISTS user_requests (message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS user_requests_window ON user_requests(user_id, created_at);
    `);
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id, messages FROM conversations").all()) {
        const value: unknown = JSON.parse(String(row.messages));
        if (!Array.isArray(value)) { contextSchema.parse(value); continue; }
        const messages = legacyHistorySchema.parse(value);
        this.archive(String(row.id), "import", messages);
        this.db.prepare("UPDATE conversations SET messages = ? WHERE id = ?")
          .run(JSON.stringify({ version: 1, model: null, messages }), String(row.id));
      }
    });
  }
  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private archive(id: string, event: "import" | "turn" | "reset", messages: ChatMessage[]) {
    this.db.prepare("INSERT INTO transcript(conversation_id, event, messages, created_at) VALUES (?, ?, ?, ?)")
      .run(id, event, JSON.stringify(messages), Date.now());
  }
  load(id: string): ConversationContext {
    const row = this.db.prepare("SELECT messages FROM conversations WHERE id = ?").get(id);
    return row ? contextSchema.parse(JSON.parse(String(row.messages))) : emptyContext();
  }
  hasProcessed(id: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM processed_messages WHERE id = ?").get(id));
  }
  markProcessed(id: string) {
    this.db.prepare("INSERT OR IGNORE INTO processed_messages VALUES (?, ?)").run(id, Date.now());
  }
  takeUserSlot(userId: string, messageId: string, now: number): number {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM user_requests WHERE created_at <= ?").run(now - USER_RATE_WINDOW_MS);
      if (this.db.prepare("SELECT 1 FROM user_requests WHERE message_id = ?").get(messageId)) return 0;
      const requests = this.db.prepare("SELECT created_at FROM user_requests WHERE user_id = ? ORDER BY created_at")
        .all(userId);
      if (requests.length >= USER_MESSAGES_PER_MINUTE) {
        return Math.max(1, Math.ceil((Number(requests[0]!.created_at) + USER_RATE_WINDOW_MS - now) / 1000));
      }
      this.db.prepare("INSERT INTO user_requests VALUES (?, ?, ?)").run(messageId, userId, now);
      return 0;
    });
  }
  save(id: string, messageId: string, context: ConversationContext, transcript: ChatMessage[] | null) {
    const validated = contextSchema.parse(context);
    this.transaction(() => {
      this.db.prepare("INSERT INTO conversations VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET messages = excluded.messages")
        .run(id, JSON.stringify(validated));
      this.archive(id, transcript === null ? "reset" : "turn", transcript ?? []);
      this.db.prepare("INSERT INTO processed_messages VALUES (?, ?)").run(messageId, Date.now());
      this.db.prepare("DELETE FROM processed_messages WHERE created_at < ?").run(Date.now() - 7 * 24 * 60 * 60_000);
    });
  }
  close() { this.db.close(); }
}
