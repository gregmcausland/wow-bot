import { ToolLoopAgent, stepCountIs, type LanguageModel } from "ai";
import type { Agent, AgentReply } from "./core/conversation.js";
import { contextMessagesSchema, retainLatestCheckpoint, type ContextMessage } from "./core/context.js";
import { createInstructions } from "./prompt.js";
import { createTools } from "./core/tools.js";

export const MAX_OUTPUT_TOKENS = 8192;
export const MAX_REPLY_CHARACTERS = 12_000;
const limitNotice = "\n\n[Reply limit reached. Ask me to continue.]";

function limitedReply(text: string) {
  let end = Math.min(text.length, MAX_REPLY_CHARACTERS - limitNotice.length);
  if (/[\uD800-\uDBFF]/.test(text[end - 1] ?? "")) end--;
  return text.slice(0, end).trimEnd() + limitNotice;
}

export function createAgent(model: LanguageModel, name: string, reasoning: string, compactThreshold = 24_000): Agent {
  const modelId = typeof model === "string" ? model : model.modelId;
  return {
    modelId,
    async reply(messages, signal, environment = {}) {
      const outputLimit = new AbortController();
      const abortSignal = AbortSignal.any([signal, outputLimit.signal]);
      const agent = new ToolLoopAgent({
        model,
        instructions: createInstructions(name),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        providerOptions: { openai: { store: false, systemMessageMode: "developer", reasoningEffort: reasoning,
          parallelToolCalls: false, contextManagement: [{ type: "compaction", compactThreshold }] } },
        maxRetries: 0,
        tools: createTools(environment, abortSignal),
        toolCallConcurrency: 1,
        stopWhen: stepCountIs(4),
        prepareStep: ({ steps, stepNumber }) => {
          const used = steps.reduce((sum, step) => sum + (step.usage.outputTokens ?? MAX_OUTPUT_TOKENS), 0);
          if (used >= MAX_OUTPUT_TOKENS) throw new Error("Request output-token budget exhausted.");
          return { maxOutputTokens: MAX_OUTPUT_TOKENS - used, ...(stepNumber === 3 ? { toolChoice: "none" as const } : {}) };
        },
        // Suppress raw SDK errors; the consumer and connector report safe metadata.
        onError: () => {},
      });
      if (Buffer.byteLength(JSON.stringify(messages)) > 2_000_000) {
        throw new Error("Saved model context exceeds the request safety budget; history is preserved.");
      }
      const uncompletedReply = (text: string): AgentReply => ({
        text, context: { version: 1, model: modelId, messages: [...messages, { role: "assistant", content: text }] },
        compactionCount: 0,
      });
      const result = await agent.stream({ prompt: messages, abortSignal });
      let text = "";
      let generatedCharacters = 0;
      for await (const part of result.fullStream) {
        signal.throwIfAborted();
        if (part.type === "error") throw part.error;
        if (part.type === "start-step") { text = ""; continue; }
        if (part.type !== "text-delta") continue;
        const remaining = MAX_REPLY_CHARACTERS - generatedCharacters;
        text += part.text.slice(0, remaining);
        generatedCharacters += Math.min(part.text.length, remaining);
        if (part.text.length >= remaining) {
          outputLimit.abort();
          // A cutoff stream cannot authorize installing a new checkpoint.
          return uncompletedReply(limitedReply(text));
        }
      }
      signal.throwIfAborted();
      const reason = await result.finishReason;
      if (reason === "length") {
        return uncompletedReply(text.trim() ? limitedReply(text)
          : "I reached the response budget before producing an answer. Please try a narrower question.");
      }
      if (reason !== "stop") throw new Error("Agent response did not complete.");
      const output: ContextMessage[] = contextMessagesSchema.parse(await result.responseMessages);
      const compactionCount = output.flatMap(message => message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter(part => part.type === "custom") : []).length;
      const context = retainLatestCheckpoint([...messages, ...output]);
      const usage = await result.totalUsage;
      console.info("Model response", { model: modelId, inputTokens: usage.inputTokens,
        cachedInputTokens: usage.inputTokenDetails.cacheReadTokens, outputTokens: usage.outputTokens,
        compactionCount });
      return { text, context: { version: 1, model: modelId, messages: context }, compactionCount };
    },
  };
}
