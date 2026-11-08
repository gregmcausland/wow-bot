import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createOpenAI } from "@ai-sdk/openai";
import { ToolLoopAgent, type ModelMessage, type LanguageModelUsage } from "ai";
import { z } from "zod";
import { createAgent, MAX_OUTPUT_TOKENS } from "../../src/agent.js";
import { readModelConfig } from "../../src/config.js";
import { createInstructions } from "../../src/prompt.js";
import { getAccessToken } from "../../src/providers/chatgpt/auth.js";
import { createOAuthFetch } from "../../src/providers/chatgpt/model.js";

const checkpointSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.object({
    type: z.literal("custom"), kind: z.literal("openai.compaction"),
    providerOptions: z.object({ openai: z.object({
      type: z.literal("compaction"), itemId: z.string().min(1), encryptedContent: z.string().min(1),
    }) }),
  })).length(1),
});
const factsSchema = z.object({
  character: z.string(), realm: z.string(), role: z.string(), raidTime: z.string(),
  raidLeader: z.string(), unresolved: z.string(), status: z.string(), tag: z.string(),
});

function usageSummary(usage: LanguageModelUsage) {
  return { inputTokens: usage.inputTokens, cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
    outputTokens: usage.outputTokens, reasoningTokens: usage.outputTokenDetails.reasoningTokens };
}

async function main() {
  const config = readModelConfig();
  const root = resolve(".data/compaction-tests");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "run-"));
  const requests: Record<string, unknown>[] = [];
  const wireInputs: unknown[][] = [];
  const stages: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(), model: config.model, reasoning: config.reasoning,
    syntheticOnly: true, requests, stages, success: false,
  };
  const writeReport = () => writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.info("Isolated test directory:", directory);
  const openai = createOpenAI({ apiKey: "oauth-managed", fetch: createOAuthFetch({
    accessToken: () => getAccessToken(config.authFile),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = await request.clone().json() as Record<string, unknown>;
      const items = Array.isArray(body.input) ? body.input as { type?: string }[] : [];
      wireInputs.push(items);
      const trace: Record<string, unknown> = {
        inputItems: items.length, inputHash: createHash("sha256").update(JSON.stringify(body.input)).digest("hex"),
        inputCharacters: JSON.stringify(body.input).length,
        compactionInputs: items.filter(item => item.type === "compaction").length,
        explicitTrigger: items.some(item => item.type === "compaction_trigger"),
        contextManagement: body.context_management ?? null, store: body.store,
        maxOutputTokens: body.max_output_tokens,
      };
      requests.push(trace);
      const response = await fetch(request);
      trace.httpStatus = response.status;
      if (!response.ok) {
        const error = await response.clone().json().catch(() => undefined) as { error?: { code?: string; param?: string; message?: string } } | undefined;
        trace.error = { code: error?.error?.code, param: error?.error?.param, message: error?.error?.message?.slice(0, 500) };
      }
      return response;
    },
  }) });
  const model = openai.responses(config.model);
  const name = process.env.BOT_NAME ?? "Murloc Holmes";
  const baseOptions = { store: false, systemMessageMode: "developer", reasoningEffort: config.reasoning };

  // Match the live agent's runtime, prompt, limits, and transport. Access the SDK's
  // full messages here because the production reply interface returns text only.
  const runtime = (compaction: "explicit" | "automatic" | "off") => new ToolLoopAgent({
    model, instructions: createInstructions(name), maxOutputTokens: MAX_OUTPUT_TOKENS, maxRetries: 0,
    onError: () => {},
    providerOptions: { openai: { ...baseOptions,
      ...(compaction === "explicit" ? { compactionTrigger: true } : {}),
      ...(compaction === "automatic" ? { contextManagement: [{ type: "compaction", compactThreshold: 2048 }] } : {}),
    } },
  });

  async function run(label: string, mode: "explicit" | "automatic" | "off", messages: ModelMessage[]) {
    console.info(`Running ${label}…`);
    const started = Date.now();
    const result = await runtime(mode).stream({ messages, abortSignal: AbortSignal.timeout(90_000) });
    await result.consumeStream({ onError: error => { throw error; } });
    const finish = await result.finishReason;
    assert.equal(finish, "stop", `${label}: response must complete without a token limit`);
    const output = await result.responseMessages;
    const entry = { label, milliseconds: Date.now() - started, finishReason: finish,
      ...usageSummary(await result.totalUsage),
      compactionItems: output.flatMap(message => message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter(part => part.type === "custom" && part.kind === "openai.compaction") : []).length,
    };
    stages.push(entry);
    await writeReport();
    console.info(JSON.stringify(entry));
    return { output, text: await result.text };
  }

  try {
    const transcript: ModelMessage[] = [{ role: "user", content: [
      "This is a synthetic memory test. Remember the following guild facts for later questions.",
      "Character: Kelra. Realm: Argent Dawn. Role: healer. Friday raid starts at 20:00 server time.",
      "Neri is the raid leader. The pending question is who brings cauldrons; nobody has volunteered.",
      "A calendar invite was requested but has NOT been sent. Guild bookkeeping tag: REEF-4821.",
    ].join("\n") }];
    const initial = await createAgent(model, name, config.reasoning).reply(
      [{ role: "user", content: String(transcript[0]!.content) + "\nAcknowledge in one short sentence." }],
      AbortSignal.timeout(90_000),
    );
    assert.ok(initial.text.trim());
    transcript.push({ role: "assistant", content: initial.text });
    // Ordinary, explicitly disposable session notes push the automatic threshold
    // without putting the answers into the later evaluation question.
    for (let index = 0; index < 28; index++) {
      transcript.push({ role: "user", content: `Disposable practice note ${index}: ` +
        "We practiced positioning, checked supplies, took a break, and discussed a harmless training example. ".repeat(6) });
      transcript.push({ role: "assistant", content: "Practice note acknowledged; no persistent decisions or completed actions." });
    }
    transcript.push({ role: "user", content: "Correction: Kelra now plays tank, replacing healer. Raid starts at 20:30, replacing 20:00. Everything else is unchanged." });
    transcript.push({ role: "assistant", content: "Noted: role is now tank and raid starts at 20:30 server time." });
    await writeFile(join(directory, "synthetic-transcript.json"), JSON.stringify(transcript, null, 2), { mode: 0o600 });

    const evaluation = "Return ONLY a JSON object with these keys, using the facts from our conversation: character, realm, role, raidTime (HH:MM), raidLeader, unresolved (pending question), status (whether the invite was sent), tag. Do not guess or add facts.";
    function verify(text: string) {
      const answer = factsSchema.parse(JSON.parse(text));
      assert.equal(answer.character, "Kelra");
      assert.equal(answer.realm, "Argent Dawn");
      assert.equal(answer.role.toLowerCase(), "tank");
      assert.equal(answer.raidTime, "20:30");
      assert.equal(answer.raidLeader, "Neri");
      assert.match(answer.unresolved, /cauldron/i);
      assert.match(answer.status, /not|unsent|pending/i);
      assert.equal(answer.tag, "REEF-4821");
      return answer;
    }

    const baseline = await run("baseline retention", "off", [...transcript, { role: "user", content: evaluation }]);
    report.baseline = verify(baseline.text);
    const capabilities: Record<string, unknown>[] = [];
    report.capabilities = capabilities;
    let compacted: Awaited<ReturnType<typeof run>> | undefined;
    for (const mode of ["explicit", "automatic"] as const) {
      try {
        const result = await run(`${mode} native compaction`, mode, [...transcript,
          ...(mode === "automatic" ? [{ role: "user" as const, content: "Acknowledge briefly; preserve our guild facts for later." }] : []),
        ]);
        const found = result.output.some(message => message.role === "assistant" && Array.isArray(message.content)
          && message.content.some(part => part.type === "custom" && part.kind === "openai.compaction"));
        capabilities.push({ mode, supported: found, completedWithoutCompaction: !found });
        if (found && !compacted) compacted = result;
      } catch {
        capabilities.push({ mode, supported: false, http: requests.at(-1)?.httpStatus, error: requests.at(-1)?.error });
        console.info(`${mode} compaction did not complete; recorded sanitized diagnostics.`);
      }
      await writeReport();
    }
    if (!compacted) {
      assert.fail("Neither streamed compaction method emitted a checkpoint; see capability probes in report.");
    }
    const parts = compacted.output.flatMap(message => message.role === "assistant" && Array.isArray(message.content)
      ? message.content.filter(part => part.type === "custom" && part.kind === "openai.compaction") : []);
    assert.ok(parts.length > 0, "Expected at least one native compaction item");
    // Automatic mode may compact more than once in a response. The latest item
    // covers earlier context; this retention test deliberately replays it alone.
    const checkpoint = checkpointSchema.parse({ role: "assistant", content: [parts.at(-1)] });
    report.checkpointItemsEmitted = parts.length;
    const checkpointPath = join(directory, "checkpoint.json");
    await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
    // Reload from disk and use a fresh agent with ONLY the opaque checkpoint.
    // The original facts, corrections, and transcript are absent from this call.
    const restored = checkpointSchema.parse(JSON.parse(await readFile(checkpointPath, "utf8")));
    assert.deepEqual(restored, checkpoint, "Checkpoint must round-trip unchanged");
    const continued = await run("checkpoint-only replay", "off", [restored, { role: "user", content: evaluation }]);
    report.replay = verify(continued.text);
    const replayInput = wireInputs.at(-1)!;
    const prefix: ModelMessage[] = [restored, { role: "user", content: evaluation }, ...continued.output];
    const appended = await run("append after replay", "off", [...prefix, { role: "user", content: "Reply ONLY with the guild bookkeeping tag." }]);
    assert.equal(appended.text.trim(), "REEF-4821");
    assert.deepEqual(wireInputs.at(-1)!.slice(0, replayInput.length), replayInput,
      "Appending a turn must preserve the earlier wire-input prefix exactly");
    report.appendOnlyPrefixVerified = true;

    report.success = true;
    report.completedAt = new Date().toISOString();
    console.info("PASS: native compaction, disk round-trip, checkpoint-only retention, and continuation. See capability results for supported trigger modes.");
  } catch (error) {
    report.failure = { name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof assert.AssertionError ? error.message : "Live request failed; see sanitized HTTP trace." };
    console.error("FAIL:", JSON.stringify(report.failure));
    process.exitCode = 1;
  } finally {
    await writeReport();
    console.info("Report:", join(directory, "report.json"));
  }
}

main().catch(() => { console.error("Could not initialize isolated compaction test."); process.exitCode = 1; });
