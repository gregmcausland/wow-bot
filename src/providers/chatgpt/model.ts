import { createOpenAI } from "@ai-sdk/openai";
import { getAccessToken } from "./auth.js";

const unsupportedFields = [
  "background", "conversation", "max_tool_calls", "metadata",
  "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier",
  "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];

export interface RequestSummary {
  model: unknown;
  streaming: boolean;
  stored: boolean;
  toolGroups: number;
  removedFields: string[];
}

function requireCompletion(response: Response): Response {
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  function inspect(line: string) {
    if (!line.startsWith("data:")) return;
    try {
      const event = JSON.parse(line.slice(5).trim()) as { type?: string; response?: { incomplete_details?: { reason?: string } } };
      if (event.type === "response.completed" || (event.type === "response.incomplete"
        && event.response?.incomplete_details?.reason === "max_output_tokens")) completed = true;
    } catch { /* The AI SDK parser reports malformed events. */ }
  }
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) inspect(line);
      controller.enqueue(chunk);
    },
    flush() {
      inspect(pending + decoder.decode());
      if (!completed) throw new Error("ChatGPT stream ended without response.completed.");
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createOAuthFetch(options: {
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
  onRequest?: (summary: RequestSummary) => void;
}): typeof fetch {
  const fetcher = options.fetch ?? fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://api.openai.com/v1/responses" || request.method !== "POST") {
      throw new Error("WoW Bot only sends OAuth inference to the public Responses endpoint.");
    }
    const body = await request.json() as Record<string, unknown>;
    if (body.stream !== true) throw new Error("Use AI SDK stream(), not generate(), for this OAuth route.");
    body.store = false;
    const removedFields = unsupportedFields.filter(field => Object.hasOwn(body, field));
    for (const field of removedFields) delete body[field];
    const tools = Array.isArray(body.tools) ? body.tools : [];
    options.onRequest?.({
      model: body.model, streaming: true, stored: false, toolGroups: tools.length, removedFields,
    });
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${await options.accessToken()}`);
    headers.set("Content-Type", "application/json");
    headers.delete("content-length");
    const response = await fetcher(request.url, {
      method: "POST", headers, body: JSON.stringify(body), signal: request.signal,
    });
    return requireCompletion(response);
  };
}

export function createChatGPTModel(authPath: string, model: string, onRequest?: (summary: RequestSummary) => void) {
  const openai = createOpenAI({
    // Required by the provider factory; replaced with the current OAuth token
    // at the request boundary. Ambient API keys are never used.
    apiKey: "oauth-managed",
    fetch: createOAuthFetch({ accessToken: () => getAccessToken(authPath), onRequest }),
  });
  return openai.responses(model);
}
