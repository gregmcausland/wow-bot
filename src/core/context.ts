import { z } from "zod";

const providerOptions = z.record(z.string(), z.record(z.string(), z.json()));
const textPart = z.object({ type: z.literal("text"), text: z.string(), providerOptions: providerOptions.optional() });
const reasoningPart = z.object({ type: z.literal("reasoning"), text: z.string(), providerOptions: providerOptions.optional() });
const toolCallPart = z.object({ type: z.literal("tool-call"), toolCallId: z.string().min(1), toolName: z.string().min(1),
  input: z.json(), providerOptions: providerOptions.optional(), providerExecuted: z.boolean().optional() });
const toolOutput = z.union([
  z.object({ type: z.enum(["text", "error-text"]), value: z.string(), providerOptions: providerOptions.optional() }),
  z.object({ type: z.enum(["json", "error-json"]), value: z.json(), providerOptions: providerOptions.optional() }),
  z.object({ type: z.literal("execution-denied"), reason: z.string().optional(), providerOptions: providerOptions.optional() }),
]);
const toolResultPart = z.object({ type: z.literal("tool-result"), toolCallId: z.string().min(1), toolName: z.string().min(1),
  output: toolOutput, providerOptions: providerOptions.optional() });
export const checkpointPartSchema = z.object({
  type: z.literal("custom"), kind: z.literal("openai.compaction"),
  providerOptions: z.object({ openai: z.object({
    type: z.literal("compaction"), itemId: z.string().min(1), encryptedContent: z.string().min(1),
  }).catchall(z.json()) }).catchall(z.record(z.string(), z.json())),
});
export const contextMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content: z.string(), providerOptions: providerOptions.optional() }),
  z.object({ role: z.literal("assistant"), content: z.union([z.string(), z.array(z.union([textPart, reasoningPart, checkpointPartSchema, toolCallPart]))]),
    providerOptions: providerOptions.optional() }),
  z.object({ role: z.literal("tool"), content: z.array(toolResultPart), providerOptions: providerOptions.optional() }),
]);
export type ContextMessage = z.infer<typeof contextMessageSchema>;
export const contextMessagesSchema = z.array(contextMessageSchema);
export const contextSchema = z.object({ version: z.literal(1), model: z.string().nullable(), messages: contextMessagesSchema });
export type ConversationContext = z.infer<typeof contextSchema>;

export function emptyContext(): ConversationContext { return { version: 1, model: null, messages: [] }; }

export function hasCheckpoint(messages: ContextMessage[]) {
  return messages.some(message => message.role === "assistant" && Array.isArray(message.content)
    && message.content.some(part => part.type === "custom"));
}

export function retainLatestCheckpoint(messages: ContextMessage[]): ContextMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const boundary = message.content.findLastIndex(part => part.type === "custom");
    if (boundary >= 0) {
      return [{ ...message, content: message.content.slice(boundary) }, ...messages.slice(index + 1)];
    }
  }
  return messages;
}
