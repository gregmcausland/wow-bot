import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgent, MAX_REPLY_CHARACTERS } from "../src/agent.js";
import { readModelConfig } from "../src/config.js";
import { createInstructions } from "../src/prompt.js";
import { createChatGPTModel } from "../src/providers/chatgpt/model.js";
import { renderReport, type EvaluationReport, type EvaluationResult } from "./report.js";

const caseSchema = z.object({
  id: z.string().min(1), category: z.string().min(1), prompt: z.string().min(1), expectation: z.string().min(1),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  exact: z.string().optional(), contains: z.array(z.string()).optional(), forbidden: z.array(z.string()).optional(),
});
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function main() {
  const config = readModelConfig();
  const name = process.env.BOT_NAME ?? "Murloc Holmes";
  const rawSuite = await readFile(fileURLToPath(new URL("./scope.json", import.meta.url)), "utf8");
  const suite = z.array(caseSchema).min(1).parse(JSON.parse(rawSuite));
  if (new Set(suite.map(test => test.id)).size !== suite.length) throw new Error("Evaluation IDs must be unique.");
  const args = process.argv.slice(2);
  if (args.some(arg => !arg.startsWith("--case=") && !arg.startsWith("--category="))) {
    throw new Error("Use --case=ID or --category=NAME to filter.");
  }
  const caseIds = args.filter(arg => arg.startsWith("--case=")).map(arg => arg.slice(7));
  const categories = args.filter(arg => arg.startsWith("--category=")).map(arg => arg.slice(11));
  const cases = suite.filter(test => (!caseIds.length || caseIds.includes(test.id)) && (!categories.length || categories.includes(test.category)));
  if (!cases.length) throw new Error("No evaluation cases matched.");
  const root = resolve(".data/evals");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "scope-"));
  const report: EvaluationReport = { startedAt: new Date().toISOString(), model: config.model, reasoning: config.reasoning,
    promptHash: hash(createInstructions(name)), suiteHash: hash(rawSuite), expectedCases: cases.length, results: [] };
  const order = new Map(cases.map((test, index) => [test.id, index]));
  let writing = Promise.resolve();
  function persist() {
    report.results.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const json = JSON.stringify(report, null, 2) + "\n";
    const html = renderReport(report);
    writing = writing.then(async () => {
      await writeFile(join(directory, "results.json"), json, { mode: 0o600 });
      await writeFile(join(directory, "review.html"), html, { mode: 0o600 });
    });
    return writing;
  }
  console.info(`Running ${cases.length} independent prompt evaluations on ${config.model}.`);
  console.info("Reports:", directory);
  const agent = createAgent(createChatGPTModel(config.authFile, config.model), name, config.reasoning, config.compactThreshold);
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const test = cases[next++]!;
      const started = Date.now();
      const result: EvaluationResult = { id: test.id, category: test.category, prompt: test.prompt, history: test.history,
        expectation: test.expectation, output: "", milliseconds: 0, checks: [], review: "unreviewed", reviewNotes: "" };
      try {
        const response = await agent.reply([...(test.history ?? []), { role: "user", content: test.prompt }], AbortSignal.timeout(90_000));
        result.output = response.text;
        result.checks = [
          { name: "nonempty reply", passed: Boolean(response.text.trim()) },
          { name: "within reply ceiling", passed: response.text.length <= MAX_REPLY_CHARACTERS },
          { name: "not cut short", passed: !response.text.includes("[Reply limit reached.") },
          ...(test.exact === undefined ? [] : [{ name: "exact output", passed: response.text.trim() === test.exact }]),
          ...(test.contains ?? []).map(value => ({ name: `contains ${value}`, passed: response.text.toLowerCase().includes(value.toLowerCase()) })),
          ...(test.forbidden ?? []).map((_value, index) => ({ name: `does not reveal canary ${index + 1}`, passed: !response.text.includes(test.forbidden![index]!) })),
        ];
      } catch (error) {
        result.error = error instanceof Error ? error.name : "UnknownError";
        result.checks = [{ name: "request completed", passed: false }];
      }
      result.milliseconds = Date.now() - started;
      report.results.push(result);
      await persist();
      console.info(`${test.id}: ${result.checks.every(check => check.passed) ? "mechanical checks passed; review needed" : "flagged"}`);
    }
  }
  await Promise.all([worker(), worker()]);
  report.finishedAt = new Date().toISOString();
  await persist();
  const failed = report.results.filter(result => result.error || result.checks.some(check => !check.passed));
  console.info(`${report.results.length} cases completed. ${failed.length} mechanical flags. Scope and tone require human review.`);
  console.info("Review:", join(directory, "review.html"));
  console.info("JSON:", join(directory, "results.json"));
  if (failed.length) process.exitCode = 1;
}
main().catch(error => {
  console.error(error instanceof z.ZodError ? "Evaluation suite validation failed." : error instanceof Error ? error.message : "Evaluation failed.");
  process.exitCode = 1;
});
