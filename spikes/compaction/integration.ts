import "dotenv/config";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOpenAI } from "@ai-sdk/openai";
import { createAgent } from "../../src/agent.js";
import { readModelConfig } from "../../src/config.js";
import { hasCheckpoint } from "../../src/core/context.js";
import { Conversations, type ChatMessage } from "../../src/core/conversation.js";
import { SqliteConversationStore } from "../../src/core/store.js";
import { getAccessToken } from "../../src/providers/chatgpt/auth.js";
import { createOAuthFetch } from "../../src/providers/chatgpt/model.js";

async function main() {
  const config = readModelConfig();
  const root = resolve(".data/compaction-tests");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "integration-"));
  const path = join(directory, "isolated.sqlite");
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), model: config.model, success: false };
  console.info("Isolated integration test:", directory);
  let store: SqliteConversationStore | undefined;
  let requestCount = 0;
  const wireInputs: unknown[][] = [];
  const model = createOpenAI({ apiKey: "oauth-managed", fetch: createOAuthFetch({
    accessToken: () => getAccessToken(config.authFile), fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().json() as { input: unknown[] };
      wireInputs.push(body.input);
      requestCount++;
      return fetch(request);
    },
  }) }).responses(config.model);
  try {
    const history: ChatMessage[] = [{ role: "user", content:
      "Remember these synthetic facts: Kelra is a healer on Argent Dawn. Raid starts at 20:00. Neri leads. " +
      "Who brings cauldrons is unresolved. The calendar invite was requested but NOT sent. Bookkeeping tag REEF-4821." },
    { role: "assistant", content: "Noted." }];
    for (let i = 0; i < 28; i++) {
      history.push({ role: "user", content: `Disposable practice note ${i}: ` +
        "We practiced positioning, checked supplies, took a break, and discussed a harmless training example. ".repeat(6) },
      { role: "assistant", content: "Practice acknowledged. No lasting decisions." });
    }
    history.push({ role: "user", content: "Correction: Kelra plays tank now and raid starts at 20:30. All other facts unchanged." },
      { role: "assistant", content: "Corrected: tank, 20:30." });
    // Seed the actual previous database format to test migration as well.
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, messages TEXT NOT NULL)");
    legacy.prepare("INSERT INTO conversations VALUES (?, ?)").run("test-room", JSON.stringify(history));
    legacy.close();
    store = new SqliteConversationStore(path);
    let now = 100_000;
    const name = process.env.BOT_NAME ?? "Murloc Holmes";
    let conversations = new Conversations(createAgent(model, name, config.reasoning, 2048), store, () => now);
    const responses: string[] = [];
    const send = async (text: string) => { responses.push(text); };
    const question = 'Return ONLY JSON with keys character, realm, role, raidTime (HH:MM), raidLeader, inviteSent (boolean), tag, unresolved. Use our conversation facts.';
    function verify(text: string) {
      const value = JSON.parse(text);
      assert.equal(value.character, "Kelra");
      assert.equal(value.realm, "Argent Dawn");
      assert.equal(value.role.toLowerCase(), "tank");
      assert.equal(value.raidTime, "20:30");
      assert.equal(value.raidLeader, "Neri");
      assert.equal(value.inviteSent, false);
      assert.equal(value.tag, "REEF-4821");
      assert.match(value.unresolved, /cauldron/i);
    }
    const message = { id: "integration:1", conversationId: "test-room", senderId: "test-user", text: question };
    await conversations.handle(message, send);
    verify(responses.at(-1)!);
    const compacted = store.load("test-room");
    assert.ok(hasCheckpoint(compacted.messages), "Production conversation path must save a native checkpoint");
    report.migrationAndCompaction = true;
    store.close();
    store = undefined;
    store = new SqliteConversationStore(path);
    assert.deepEqual(store.load("test-room"), compacted);
    // Return to the production threshold after forcing one test compaction.
    conversations = new Conversations(createAgent(model, name, config.reasoning, config.compactThreshold), store, () => now);
    now += 1000;
    await conversations.handle({ ...message, id: "integration:2" }, send);
    verify(responses.at(-1)!);
    const afterReplay = store.load("test-room");
    assert.deepEqual(afterReplay.messages.slice(0, compacted.messages.length), compacted.messages);
    const replayInput = wireInputs.at(-1)!;
    report.persistedReplayAndRetention = true;
    now += 1000;
    await conversations.handle({ ...message, id: "integration:3", text: "Reply ONLY with our bookkeeping tag." }, send);
    assert.equal(responses.at(-1)!.trim(), "REEF-4821");
    assert.deepEqual(wireInputs.at(-1)!.slice(0, replayInput.length), replayInput);
    report.appendOnlyPrefix = true;
    for (let i = 4; i <= 5; i++) {
      now += 1000;
      await conversations.handle({ ...message, id: `integration:${i}`, conversationId: `test-room-${i}`, text: "Reply ONLY READY." }, send);
    }
    const beforeLimited = requestCount;
    now += 1000;
    await conversations.handle({ ...message, id: "integration:6", conversationId: "other-room", text: "This must not call the model." }, send);
    assert.equal(requestCount, beforeLimited);
    assert.match(responses.at(-1)!, /55 seconds/);
    assert.match(responses.at(-1)!, /Mrrgl/);
    report.rateLimitWithoutModelCall = true;
    const audit = new DatabaseSync(path, { readOnly: true });
    const events = audit.prepare("SELECT event FROM transcript WHERE conversation_id = ? ORDER BY sequence").all("test-room");
    assert.deepEqual(events.map(row => row.event), ["import", "turn", "turn", "turn"]);
    audit.close();
    report.originalTranscriptPreserved = true;
    report.success = true;
    console.info("PASS: production migration, compaction, persisted replay, fact retention, stable prefix, archive, and non-AI rate limit.");
  } catch (error) {
    report.failure = error instanceof assert.AssertionError ? error.message : "Integration failed; raw response details withheld.";
    console.error("FAIL:", report.failure);
    process.exitCode = 1;
  } finally {
    store?.close();
    report.requests = requestCount;
    report.completedAt = new Date().toISOString();
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.info("Report:", join(directory, "report.json"));
  }
}
main().catch(() => { console.error("Could not initialize isolated integration test."); process.exitCode = 1; });
