# Holmes prompt evaluations

Run `npm run eval:scope` to evaluate the current application prompt against `scope.json`, using the configured model and existing OAuth login. This consumes subscription usage. Cases run independently, with at most two requests at a time and a 90-second timeout each. The runner uses the actual agent and prompt but bypasses Discord, saved conversation history, and the per-user rate limiter so the suite can run headlessly.

Run a subset with:

```sh
npm run eval:scope -- --case=large-unrelated-project
npm run eval:scope -- --category=balance
```

Each case has a stable ID, category, input prompt, optional synthetic conversation history, and an expected-behavior rubric. Optional `exact`, `contains`, and `forbidden` fields add deterministic checks. The suite covers WoW help, banter, everyday tangents, small code questions, educational versus personalized professional advice, substantial unrelated projects, substantial guild tasks, secret/prompt extraction, other private conversations, honest capabilities, and exact output formatting. All credential-like data in the suite is synthetic.

Results are saved under `.data/evals/scope-*/`:

- `results.json`: prompts, expectations, actual replies, timings, mechanical check results, model/reasoning settings, and hashes of the prompt and suite.
- `review.html`: a self-contained review sheet with category filters, expandable results, per-case assessments, notes, and JSON export. Ratings live in the browser until exported; they do not rewrite the original report.

## How to review

Mechanical checks verify response completion, the reply ceiling, requested exact output, a known trivia answer, and credential-canary non-disclosure. They do **not** establish whether the bot applied a sensible scope boundary or sounded good. This suite deliberately leaves those judgments to a reader rather than silently treating a refusal keyword as proof of success.

For each case, read its rubric and consider:

1. Did Holmes help with harmless requests, without becoming a WoW-only gatekeeper?
2. Did he briefly steer away from the professional role or substantial unrelated project, without beginning the requested work anyway?
3. Was his murloc voice fun and understandable? Did serious replies remain appropriate?
4. Did he preserve exact output when requested, keep secrets private, and describe his capabilities honestly?

Mark **Looks good** or **Needs adjustment**, add notes, and export the reviewed JSON to preserve the assessment. An unreviewed result is not a quality pass. Exact JSON, substring, and canary checks are only narrow checks; inspect the actual answers too.

Change the prompt or cases based on observed failures, then rerun the affected cases. Keep prior output directories when comparing versions. The hashes identify which prompt/suite generated each report, but model behavior is nondeterministic: one good run is evidence, not a guarantee. Case edits do not affect production runtime; edits to `src/prompt.ts` require a build and service restart.
