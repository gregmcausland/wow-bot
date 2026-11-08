import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, tool, stepCountIs } from "ai";
import { z } from "zod";
import { getAccessToken, login, readAuth, updateAuth } from "../src/providers/chatgpt/auth.js";
import { createOAuthFetch } from "../src/providers/chatgpt/model.js";
import { createAgent, MAX_OUTPUT_TOKENS, MAX_REPLY_CHARACTERS } from "../src/agent.js";

const temporaryDirectories: string[] = [];
async function authPath() {
  const directory = await mkdtemp(join(tmpdir(), "wow-bot-oauth-"));
  temporaryDirectories.push(directory);
  return join(directory, "auth.json");
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

const completed = { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5 } } };
const created = { type: "response.created", response: { id: "resp_fixture", created_at: 123, model: "gpt-5.5" } };
function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      // Exercise boundaries inside event names and JSON, not just between events.
      for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}
function textEvents(text: string) {
  return [created,
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_fixture" } },
    { type: "response.output_text.delta", output_index: 0, item_id: "msg_fixture", delta: text },
    { type: "response.output_item.done", output_index: 0, item: {
      type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    } }, completed,
  ];
}

function nativeEvents(text: string) {
  const textOutput = textEvents(text).slice(1).map(event => "output_index" in event ? { ...event, output_index: 1 } : event);
  return [created, { type: "response.output_item.done", output_index: 0,
    item: { type: "compaction", id: "compact_fixture", encrypted_content: "opaque-checkpoint" } }, ...textOutput];
}

describe("direct OAuth request boundary", () => {
  it("executes a real tool loop, preserves calls/results, and shares the output budget between steps", async () => {
    const requests: Record<string, unknown>[] = [];
    const recent = vi.fn(async () => ({ status: "ok" as const, channelId: "room", channelName: "guild", messages: [], hasMore: false }));
    const working = vi.fn(async () => {});
    const openai = createOpenAI({ apiKey: "unused", fetch: createOAuthFetch({ accessToken: async () => "test", fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length !== 1) return sse(textEvents("Friday is raid night."));
      const item = { type: "function_call", id: "fc_chat", call_id: "call_chat", name: "read_recent_chat", arguments: '{"limit":2}', status: "completed" };
      return sse([created,
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
        { type: "response.output_item.done", output_index: 0, item }, completed,
      ]);
    } }) });
    const agent = createAgent(openai.responses("gpt-5.5"), "Holmes", "low");
    const result = await agent.reply([{ role: "user", content: "What did we agree?" }], AbortSignal.timeout(5000), {
      chat: { authorize: async () => undefined, recent, pins: async () => ({ status: "denied", reason: "no pins" }) },
      onWorking: working,
    });
    expect(recent).toHaveBeenCalledOnce();
    expect(working).toHaveBeenCalledOnce();
    expect(result.text).toBe("Friday is raid night.");
    expect(result.context.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: expect.arrayContaining([expect.objectContaining({ type: "tool-call", toolCallId: "call_chat" })]) }),
      expect.objectContaining({ role: "tool", content: expect.arrayContaining([expect.objectContaining({ type: "tool-result", toolCallId: "call_chat" })]) }),
    ]));
    expect(requests[1]!.max_output_tokens).toBe(MAX_OUTPUT_TOKENS - 5);
    const restored = JSON.parse(JSON.stringify(result.context.messages));
    await agent.reply([...restored, { role: "user", content: "Remember that?" }], AbortSignal.timeout(5000));
    expect(requests[2]!.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_chat" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_chat" }),
    ]));
  });

  it("enables automatic compaction, persists its suffix, and replays it without the original prefix", async () => {
    const requests: Record<string, unknown>[] = [];
    const openai = createOpenAI({ apiKey: "unused", fetch: createOAuthFetch({ accessToken: async () => "test", fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return sse(requests.length === 1 ? nativeEvents("First answer") : textEvents("Second answer"));
    } }) });
    const agent = createAgent(openai.responses("gpt-5.5"), "Holmes", "low");
    const first = await agent.reply([{ role: "user", content: "Original facts" }], AbortSignal.timeout(5000));
    expect(first.compactionCount).toBe(1);
    expect(first.context.messages).toHaveLength(1);
    expect(first.context.messages[0]).toMatchObject({ role: "assistant", content: [
      { type: "custom", kind: "openai.compaction" }, { type: "text", text: "First answer" },
    ] });
    const restored = JSON.parse(JSON.stringify(first.context.messages));
    const next = await agent.reply([...restored, { role: "user", content: "Follow up" }], AbortSignal.timeout(5000));
    expect(next.compactionCount).toBe(0);
    expect(requests[0]!.context_management).toEqual([{ type: "compaction", compact_threshold: 24_000 }]);
    expect(requests[1]!.input).toEqual(expect.arrayContaining([
      { type: "compaction", id: "compact_fixture", encrypted_content: "opaque-checkpoint" },
    ]));
    expect(JSON.stringify(requests[1]!.input)).not.toContain("Original facts");
    expect(JSON.stringify(requests[1]!.input)).toContain("First answer");
  });

  it("does not install a checkpoint from a disconnected stream", async () => {
    const input = [{ role: "user" as const, content: "Keep my facts" }];
    const openai = createOpenAI({ apiKey: "unused", fetch: createOAuthFetch({
      accessToken: async () => "test", fetch: async () => sse(nativeEvents("Partial answer").slice(0, -1)),
    }) });
    const agent = createAgent(openai.responses("gpt-5.5"), "Holmes", "low");
    await expect(agent.reply(input, AbortSignal.timeout(5000))).rejects.toThrow();
    expect(input).toEqual([{ role: "user", content: "Keep my facts" }]);
  });

  it("delivers a useful token-limited answer while discarding its incomplete checkpoint", async () => {
    const events = nativeEvents("Useful partial answer").slice(0, -1);
    events.push({ type: "response.incomplete", response: { ...completed.response,
      incomplete_details: { reason: "max_output_tokens" } } } as typeof completed);
    const openai = createOpenAI({ apiKey: "unused", fetch: createOAuthFetch({
      accessToken: async () => "test", fetch: async () => sse(events),
    }) });
    const agent = createAgent(openai.responses("gpt-5.5"), "Holmes", "low");
    const reply = await agent.reply([{ role: "user", content: "Original facts" }], AbortSignal.timeout(5000));
    expect(reply.text).toContain("Useful partial answer");
    expect(reply.compactionCount).toBe(0);
    expect(reply.context.messages[0]).toEqual({ role: "user", content: "Original facts" });
    expect(JSON.stringify(reply.context.messages)).not.toContain("opaque-checkpoint");
  });

  it("runs the application agent against the real provider parser", async () => {
    let body: Record<string, unknown> | undefined;
    const openai = createOpenAI({
      apiKey: "unused-placeholder",
      fetch: createOAuthFetch({ accessToken: async () => "test-oauth", fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sse(textEvents("Hello from the agent"));
      } }),
    });
    const agent = createAgent(openai.responses("gpt-5.5"), "WoW Bot", "low");
    expect(await agent.reply([{ role: "user", content: "Hello" }], AbortSignal.timeout(5000)))
      .toMatchObject({ text: "Hello from the agent" });
    expect(body?.max_output_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("stops upstream generation at the visible reply ceiling and marks the answer", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const openai = createOpenAI({
      apiKey: "unused",
      fetch: createOAuthFetch({ accessToken: async () => "test", fetch: async (_input, init) => {
        upstreamSignal = init?.signal ?? undefined;
        return sse(textEvents("x".repeat(MAX_REPLY_CHARACTERS + 1000)));
      } }),
    });
    const agent = createAgent(openai.responses("gpt-5.5"), "WoW Bot", "low");
    const reply = await agent.reply([{ role: "user", content: "Long answer" }], AbortSignal.timeout(5000));
    expect(reply.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARACTERS);
    expect(reply.text).toContain("Reply limit reached");
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("delivers and marks a token-limited answer instead of treating it as a network failure", async () => {
    const events = textEvents("A useful partial answer");
    events[events.length - 1] = {
      type: "response.incomplete",
      response: { ...completed.response, incomplete_details: { reason: "max_output_tokens" } },
    } as typeof completed;
    const openai = createOpenAI({ apiKey: "unused", fetch: createOAuthFetch({
      accessToken: async () => "test", fetch: async () => sse(events),
    }) });
    const agent = createAgent(openai.responses("gpt-5.5"), "WoW Bot", "low");
    const reply = await agent.reply([{ role: "user", content: "Hello" }], AbortSignal.timeout(5000));
    expect(reply.text).toContain("A useful partial answer");
    expect(reply.text).toContain("Reply limit reached");
  });

  it("injects the current token and removes incompatible fields without changing input", async () => {
    let sent: Request | undefined;
    const transport: typeof fetch = async (input, init) => {
      sent = new Request(input, init);
      return sse([completed]);
    };
    const request = createOAuthFetch({ accessToken: async () => "oauth-test-token", fetch: transport });
    const response = await request("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: "Bearer stale-placeholder" },
      body: JSON.stringify({
        model: "test", stream: true, store: true, temperature: 0.5,
        max_output_tokens: 100, previous_response_id: "old", input: [{ role: "user", content: "hello" }],
      }),
    });
    await response.text();
    expect(sent!.headers.get("Authorization")).toBe("Bearer oauth-test-token");
    expect(await sent!.json()).toEqual({ model: "test", stream: true, store: false, max_output_tokens: 100, input: [{ role: "user", content: "hello" }] });
  });

  it("rejects the wrong endpoint or a non-streaming call before reading credentials", async () => {
    const accessToken = vi.fn(async () => "secret");
    const request = createOAuthFetch({ accessToken });
    await expect(request("https://example.com/responses", { method: "POST" })).rejects.toThrow("public Responses endpoint");
    await expect(request("https://api.openai.com/v1/responses", {
      method: "POST", body: JSON.stringify({ stream: false }),
    })).rejects.toThrow("stream()");
    expect(accessToken).not.toHaveBeenCalled();
  });

  it("rejects a truncated stream instead of accepting partial output as success", async () => {
    const request = createOAuthFetch({ accessToken: async () => "test", fetch: async () => sse(textEvents("partial").slice(0, -1)) });
    const response = await request("https://api.openai.com/v1/responses", {
      method: "POST", body: JSON.stringify({ stream: true }),
    });
    await expect(response.text()).rejects.toThrow("without response.completed");
  });

  it("uses the real OpenAI provider parser and Vercel tool loop with namespaced tool replay", async () => {
    const requests: Record<string, unknown>[] = [];
    const execute = vi.fn(async () => ({ value: "from-local-tool" }));
    const transport: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        const item = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", namespace: "spike", arguments: "{}", status: "completed" };
        return sse([created,
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: "{}" },
          { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: "{}" },
          { type: "response.output_item.done", output_index: 0, item }, completed,
        ]);
      }
      return sse(textEvents("from-local-tool"));
    };
    const openai = createOpenAI({
      apiKey: "unused-placeholder", fetch: createOAuthFetch({ accessToken: async () => "test-oauth", fetch: transport }),
    });
    const agent = new ToolLoopAgent({
      model: openai.responses("gpt-5.5"), stopWhen: stepCountIs(3), maxRetries: 0,
      providerOptions: { openai: { store: false, systemMessageMode: "developer" } },
      tools: { lookup: tool({
        description: "Look up a test value", inputSchema: z.object({}), execute,
        providerOptions: { openai: { namespace: { name: "spike", description: "Test tools" } } },
      }) },
    });
    const result = await agent.stream({ prompt: "Use lookup." });
    await result.consumeStream();
    expect(await result.text).toBe("from-local-tool");
    expect(await result.finishReason).toBe("stop");
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools).toMatchObject([{ type: "namespace", name: "spike", tools: [{ type: "function", name: "lookup" }] }]);
    expect(requests[1]!.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", call_id: "call_fixture", name: "lookup", namespace: "spike" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_fixture", output: '{"value":"from-local-tool"}' }),
    ]));
  });
});

describe("ChatGPT OAuth lifecycle", () => {
  it("rejects unsafe external connection origins before starting login", async () => {
    const path = await authPath();
    for (const publicOrigin of ["http://bot.example", "https://bot.example/path", "https://user:pass@bot.example", "https://bot.example/?query=1"]) {
      await expect(login(path, () => {}, new AbortController().signal, { publicOrigin }))
        .rejects.toThrow("HTTPS origin");
    }
    expect(await readAuth(path)).toBeUndefined();
  });

  it("refreshes once across concurrent requests and persists the rotated token privately", async () => {
    const path = await authPath();
    await updateAuth(path, async state => {
      state.clientId = "issued-client";
      state.credentials = { accessToken: "expired", refreshToken: "old-refresh", expiresAt: 0, scopes: ["chatgpt.tokens.use.direct"] };
    });
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("issued-client");
      expect(body.get("resource")).toBe("https://api.openai.com/v1");
      return Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 });
    });
    expect(await Promise.all([getAccessToken(path, transport), getAccessToken(path, transport)])).toEqual(["fresh", "fresh"]);
    expect(transport).toHaveBeenCalledOnce();
    expect((await readAuth(path))!.credentials!.refreshToken).toBe("rotated");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves credentials if refresh fails and does not leak the error response", async () => {
    const path = await authPath();
    await updateAuth(path, async state => {
      state.clientId = "issued";
      state.credentials = { accessToken: "old", refreshToken: "keep", expiresAt: 0, scopes: ["chatgpt.tokens.use.direct"] };
    });
    const previous = await readFile(path, "utf8");
    await expect(getAccessToken(path, async () => new Response("private-debug-token", { status: 400 })))
      .rejects.toThrow("HTTP 400");
    expect(await readFile(path, "utf8")).toBe(previous);
  });

  it("starts PKCE login, rejects mismatched state, and preserves the host across cancelled attempts", async () => {
    const path = await authPath();
    const abort = new AbortController();
    let ready!: (url: string) => void;
    const urlReady = new Promise<string>(resolve => { ready = resolve; });
    const attempt = login(path, ready, abort.signal);
    const settled = expect(attempt).rejects.toThrow("cancelled");
    const startUrl = await urlReady;
    expect((await fetch(startUrl)).status).toBe(200);
    const response = await fetch(new URL("/start", startUrl), { redirect: "manual" });
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin).toBe("https://auth.openai.com");
    expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toBeTruthy();
    expect(authorize.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({ code: "fake-code", client_id: "issued", state: "wrong" }).toString();
    expect((await fetch(callback)).status).toBe(400);
    const complete = new URL("/complete", startUrl);
    const submit = (callbackUrl: string, origin = new URL(startUrl).origin) => fetch(complete, {
      method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ callback: callbackUrl }),
    });
    expect((await submit(callback.toString(), "https://other.example")).status).toBe(403);
    expect((await submit("https://other.example/auth/callback?state=anything")).status).toBe(400);
    expect((await submit(callback.toString())).status).toBe(400);
    abort.abort();
    await settled;
    const saved = await readAuth(path);
    expect(saved!.hostId).toBe(authorize.searchParams.get("ext_agent_host_id"));
    expect(saved!.credentials).toBeUndefined();
  });
});
