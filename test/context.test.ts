import { expect, it } from "vitest";
import { contextMessagesSchema, retainLatestCheckpoint, type ContextMessage } from "../src/core/context.js";

const checkpoint = (id: string) => ({ type: "custom" as const, kind: "openai.compaction" as const,
  providerOptions: { openai: { type: "compaction" as const, itemId: id, encryptedContent: `opaque-${id}` } } });

it("retains the latest native checkpoint and the entire suffix, including parts within the same message", () => {
  const messages: ContextMessage[] = [
    { role: "user", content: "Original transcript" },
    { role: "assistant", content: [checkpoint("first"), { type: "text", text: "Old reply" }] },
    { role: "user", content: "Later request" },
    { role: "assistant", content: [{ type: "text", text: "Before new checkpoint" }, checkpoint("latest"),
      { type: "reasoning", text: "", providerOptions: { openai: { reasoningEncryptedContent: "reasoning-data" } } },
      { type: "text", text: "After new checkpoint" }] },
    { role: "user", content: "Suffix" },
  ];
  expect(retainLatestCheckpoint(messages)).toEqual([
    { ...messages[3], content: (messages[3]!.content as unknown[]).slice(1) }, messages[4],
  ]);
  expect(messages).toHaveLength(5);
});

it("leaves ordinary history unchanged and preserves provider metadata through persistence parsing", () => {
  const messages: ContextMessage[] = [{ role: "user", content: "Question" }, { role: "assistant", content: [
    { type: "text", text: "Answer", providerOptions: { openai: { itemId: "message-id", annotations: [] } } },
  ] }];
  expect(retainLatestCheckpoint(messages)).toBe(messages);
  expect(contextMessagesSchema.parse(JSON.parse(JSON.stringify(messages)))).toEqual(messages);
});

it("rejects malformed native context and does not elevate summaries to instructions", () => {
  expect(() => contextMessagesSchema.parse([{ role: "assistant", content: [{ ...checkpoint("bad"), providerOptions: {} }] }])).toThrow();
  expect(() => contextMessagesSchema.parse([{ role: "system", content: "Elevated summary" }])).toThrow();
});

it("preserves tool call/result groups and their metadata after a native checkpoint", () => {
  const messages: ContextMessage[] = [
    { role: "assistant", content: [checkpoint("latest"), { type: "tool-call", toolCallId: "read-1", toolName: "read_recent_chat",
      input: { limit: 2 }, providerOptions: { openai: { itemId: "fc-1" } } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "read-1", toolName: "read_recent_chat",
      output: { type: "json", value: { status: "ok", messages: [{ text: "Friday" }] } } }] },
    { role: "assistant", content: "Friday is agreed." },
  ];
  const restored = contextMessagesSchema.parse(JSON.parse(JSON.stringify(messages)));
  expect(retainLatestCheckpoint(restored)).toEqual(messages);
});
