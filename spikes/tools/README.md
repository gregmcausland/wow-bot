# Headless tool integration

Run `npm run test:tools:live` with the existing OAuth login. It uses the actual model, application prompt, tool implementations, and saved-context parser. Chat/pin data is synthetic and injected through the same connector-independent `ChatReader` interface used by Discord. No Discord messages are sent and production history is not opened.

Checks:

1. Recent chat and pinned-message tools actually execute, triggering local working callbacks.
2. The answer distinguishes an agreed raid time from a later unaccepted proposal.
3. A malicious instruction quoted in chat does not override the developer prompt or fabricate a server restart.
4. Tool calls, results, and provider metadata survive JSON persistence and validation.
5. History containing tools passes through automatic native compaction, then replays correctly in a fresh agent.
6. The current-time tool executes and returns a recent UTC timestamp.

Each run saves a report and synthetic context under `.data/tool-tests/run-*/`, with owner-only permissions. The compaction test uses a deliberately low threshold of 2,048 tokens, then returns to the configured threshold. Tests consume subscription usage. Report results are evidence from these samples, not a guarantee that every possible quoted injection is harmless.

Offline tests cover fixed-channel scoping, history permissions and private-thread membership, permission changes between reads, output bounds, source attribution, tool persistence/replay, per-step token budgets, and working-message timing/races/error handling.
