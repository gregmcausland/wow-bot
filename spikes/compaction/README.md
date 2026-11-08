# Headless native compaction probe

Run `npm run test:compaction:live` after connecting OAuth. This is a live test and consumes subscription usage. It reads the configured model, reasoning, and login from the normal environment. It does not start Discord or open the production conversation database.

The probe uses the application's agent wrapper for the initial acknowledgement, and the same model transport, prompt, output budget, and `ToolLoopAgent` for the remaining calls. The lower-level SDK interface tests each capability separately. No changes to the running bot are needed.

It creates an owner-only directory under `.data/compaction-tests/` containing a synthetic transcript, encrypted checkpoint, and sanitized JSON report. No access/refresh tokens or raw HTTP headers are saved. OAuth refresh may update the existing credential file through the normal locked credential handler.

## Checks

1. Establish synthetic character, guild, and pending-action facts; add disposable practice notes and explicit corrections.
2. Verify those facts against the original context.
3. Probe explicit `compactionTrigger` and automatic `contextManagement` with a deliberately low 2,048-token threshold. Record HTTP capability failures separately; an unsupported explicit trigger does not prevent automatic mode from passing.
4. Require completed responses and at least one encrypted compaction item. Automatic compaction may emit multiple checkpoints; select the latest for the retention test.
5. Save and reload the checkpoint without modifying it, then ask a fresh agent to recover the facts using only that checkpoint and the evaluation question. The question contains no expected answers.
6. Append another turn and verify the bookkeeping tag, exact wire-input prefix stability, and provider-reported cached-token usage.

Each request has a 90-second timeout, the normal 8,192-output-token budget, and no automatic retries. There is no API-key fallback. This test does not call the standalone `/responses/compact` endpoint.

## Observed result: 2026-10-30

With the current subscription OAuth login and `gpt-6.1-terra`:

- The explicit trigger returned HTTP 400, code `subscription_sharing_unsupported_capability`, for the input item.
- Automatic threshold-based compaction completed and emitted two encrypted checkpoints.
- Disk round-trip and checkpoint-only replay passed all eight fact assertions, including corrected values and an invite that was requested but never sent.
- A subsequent turn preserved the earlier request prefix exactly and reported cached input tokens.

The passing report is `.data/compaction-tests/run-DGh6Ga/report.json`. The encrypted checkpoint is local test data, not a production memory record.

This establishes compatibility and basic retention. The low test threshold caused multiple compactions and is not a recommended live threshold. The synthetic context is small and repetitive; its token counts do not establish compression effectiveness for realistic chats. Repeated compactions, realistic long-context retention, tools, and native replay across process restarts still need separate validation. In production, preserve the latest checkpoint and every subsequent context item; this probe deliberately drops the suffix to isolate checkpoint retention.

## Production integration test

Run `npm run test:compaction:integration` to exercise the actual `Conversations`, agent, and SQLite implementation headlessly. It creates an isolated database with the old text-history format, migrates it, forces one compaction at a low test threshold, reopens the database, and continues using the normal production threshold. It checks corrected facts, pending-action status, preserved request prefixes, transcript retention, and the local rate-limit response after five requests across conversations. Its synthetic rate-limit clock avoids waiting a minute. The sixth request must not increase the HTTP request count. Each run saves a separate `integration-*/report.json`.
