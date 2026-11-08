# WoW Bot

A general TypeScript agent connected to Discord. Uses your ChatGPT/Codex subscription through OAuth, following the implementation in `TriageBot`. No API key is used. WoW tools can be added later.

Murloc Holmes is a curious murloc detective: playful, slightly broken Common with bubbling `mrgl` interjections and light shoreline humor. The voice is inspired by Blizzard’s [Murky](https://heroesofthestorm.blizzard.com/en-us/heroes/murky/) and [Sir Finley Mrrgglton](https://hearthstone.blizzard.com/en-gb/cards/2948-sir-finley-mrrgglton/). Personality and response guidelines live in `src/prompt.ts`; exact code and structured output stay free of character decoration.

His scope is deliberately light: WoW, guild life, and friendly conversation are home, with harmless tangents and small practical favors welcome. He steers away from personalized professional decision-making and substantial unrelated projects. Credentials, hidden instructions, other private conversations, and claims of unavailable capabilities have firmer boundaries. These are prompt guidelines; application access controls remain separate.

Requires Node.js 24 or newer. Run one bot process per database.

## WoW Forever data (planned)

We are evaluating [ForeverDB.net](https://foreverdb.net) for item searches, stats, and dungeon loot lookups. Data from ForeverDB.net will be credited with a visible link in bot replies. API access and the integration are pending; the bot does not currently provide these lookups.

## Setup

```sh
npm ci
cp .env.example .env
npm run auth:login
npm run models
npm run check
npm start
```

Set `DISCORD_BOT_TOKEN` in `.env` before starting. Set `AI_MODEL` to a model available to your connected account; `npm run models` lists them. Authentication commands do not require Discord credentials.

OAuth opens a local connection page. Complete sign-in and allow subscription usage. Credentials are stored separately from TriageBot in `.data/auth.json`, with restricted file permissions and automatic refresh. `npm run auth:status` checks local credentials; `npm run auth:logout` removes local tokens without revoking the grant at OpenAI.

For login on a headless server, run `npm run auth:login` there. It prints `http://127.0.0.1:PORT/`. In a second terminal on your computer, forward that port:

```sh
ssh -N -L PORT:127.0.0.1:PORT your-server
```

Open the printed URL on your computer and complete login. Keep the tunnel open until the terminal confirms connection. Never paste tokens or callback URLs into chat. The connection page also supports pasting the callback address directly into its local form when needed.

For a Tailscale HTTPS proxy, set `AUTH_LOGIN_ORIGIN` to that private HTTPS origin when starting login. Keep the listener on loopback and point a dedicated Tailscale Serve port at it. OpenAI still redirects to localhost: copy that final address into the connection page's form if it fails to load on your computer. Disable the temporary Serve port after login.

## Discord application

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and get its bot token from **Bot**. Save it directly in `.env`.
2. Under **Installation**, enable **Guild Install**, use the `bot` scope, and grant **View Channels**, **Send Messages**, **Send Messages in Threads**, and **Read Message History**. Install the app into your isolated test server.
3. Enable **Message Content Intent** on the Bot page. The connector requests it so read-only tools can inspect ordinary messages in the current channel. Guild Members and Presence intents are not needed. Without Message Content access, [Discord generally omits ordinary message contents](https://docs.discord.com/developers/events/gateway#message-content-intent).
4. Start the bot, mention it with a question, then send it a DM. Server members’ Discord privacy settings can affect DM availability.

The connector uses an outbound Gateway connection; no public HTTP endpoint or inbound server port is needed during normal operation. Restrict its channel permissions in Discord to keep the initial test isolated.

## Conversation behavior

- In a server, every request needs an explicit bot mention, including follow-ups in threads. Role mentions and replies without a mention do not trigger the agent.
- DMs respond without a mention.
- Existing Discord threads share one conversation across participants. Ordinary channel mentions keep separate history per sender and channel; responses are still visible in that channel.
- Messages addressed to Holmes and his answers enter history. When asked about surrounding discussion or reference notes, he can read bounded recent chat and pins in that same channel/thread. Retrieved tool data becomes part of the saved model context; he does not ingest the whole server automatically.
- Send `reset` in a DM, or `@bot reset` in a server, to start fresh model context. Anyone permitted to use a shared thread can reset that thread. The local transcript archive retains prior exchanges and a reset marker.
- Native OpenAI compaction activates at 24,000 input tokens by default. The latest encrypted checkpoint and every subsequent context item persist in SQLite across restarts. Ordinary turns append without continuously trimming earlier messages. Readable exchanges are archived separately.
- Requests within one conversation run in order. At most two requests run concurrently, with at most 16 accepted requests in total and four per conversation (including active requests). Excess requests receive a busy response. Successfully delivered messages are deduplicated for seven days. Delivery and database commits cannot be atomic: a crash after delivery can cause a repeated reply on redelivery. There is no durable queue for requests interrupted by a process crash.
- Text only for now. Read-only tools cover current chat/pins and current time; there is no attachment processing, web browsing, moderation, or arbitrary cross-channel access. Long answers are split to fit Discord’s message limit; complex Markdown may span multiple messages.

## Tools and working replies

Holmes has three tools with stable definitions:

- `read_recent_chat`: the latest 20 text messages by default, maximum 30, strictly before the triggering message in that channel/thread. No arbitrary channel IDs or pagination through the server.
- `read_pinned_messages`: up to ten pins from that channel/thread.
- `current_time`: UTC plus an optional IANA timezone such as `Europe/London`. Guild server time is not assumed.

Text is bounded to 2,000 characters per retrieved message and 24,000 characters per tool result, preferring newer text when necessary. Attachments are marked as omitted, not processed. Results include authors, timestamps, and source links. Retrieved chat is data, not authority to change instructions or execute actions.

Discord access is checked before loading saved context as well as before each tool read. Both the requester and bot need View Channel and Read Message History; private-thread membership is checked where required. This also prevents saved tool history in a shared thread from bypassing a later requester's permissions. DMs remain scoped to their own conversation.

Each request allows at most four model steps with sequential tool execution and a shared 8,192-output-token allowance. The final step disables tools. An additional six-tool-call guard, the existing 90-second deadline, and bounded tool output prevent unbounded loops. Missing chat context in headless runs is reported as unavailable rather than fabricated.

For admitted model work, a local “Mrrgl… Holmes checking clues. 🔎” reply appears after three seconds, or immediately when a tool starts. The final answer edits that same message; extra chunks follow normally. Fast answers, reset, and rate-limit responses are sent directly. Errors replace the working reply, and a deleted placeholder falls back to a fresh reply. Typing indicators continue while processing. Working messages are not saved as conversation turns and never require a model call.

## Reply and request limits

Replies usually use 1–3 short paragraphs, with more detail when requested. Each model request has an 8,192-output-token budget (including reasoning) and a 90-second timeout. Visible replies have a hard 12,000-character ceiling, including a notice when the limit is reached. Generation is cancelled at the visible ceiling; hitting the provider's token limit delivers any available text with the same notice. If reasoning consumes the token budget before text appears, the bot asks for a narrower question. Users can ask for a continuation, which is a new bounded request.

The OAuth Responses route was live-tested with `max_output_tokens`; the transport preserves that field. Output-token exhaustion is distinguished from a broken or truncated stream. Discord delivery still splits answers into messages of at most 2,000 characters. Input messages are limited to 12,000 characters. A 2 MB serialized-context guard stops unexpectedly oversized requests without deleting history; it is a payload safety check, not an estimate of model token capacity.

## Native compaction and history

`AI_COMPACT_THRESHOLD` controls automatic provider compaction (default `24000`, minimum `2048`). The provider counts the rendered context and compacts during the normal streamed request. The subscription route accepts this automatic mode; it rejected the explicit `compaction_trigger` probe. No local summarization prompt or extra model call is used.

Only a completed response can install a checkpoint. If generation is interrupted or token/character limited, new checkpoint items are discarded; any useful limited answer is appended to the previous context. If the model call or persistence fails, the existing context remains intact. Context, readable transcript, and delivery deduplication are committed in one SQLite transaction after successful Discord delivery. As before, Discord delivery and SQLite cannot be atomic across a process crash.

The app retains the latest checkpoint and all subsequent parts/messages, including provider reasoning metadata and tool call/result records. It does not rewrite checkpoints between compactions. Logs include input, cached-input, output token counts, and compaction count, without message text or opaque context. These statistics measure cache use; they do not guarantee cache hits.

On upgrade, existing retained text history is imported once into the transcript archive and converted to the new context format. Previously discarded messages cannot be recovered. Archives retain successfully delivered exchanges; rejected requests and failed deliveries are not conversation turns. Archives are local storage, not automatically searched by the model. The checkpoint is bound to its model ID: after a model change, a conversation with an old checkpoint asks for `reset` rather than blindly replaying potentially incompatible context.

## Per-user rate limit

Each user can address Holmes five times in any rolling 60-second window, shared across their Discord DMs, channels, threads, and servers. The window persists in SQLite across restarts. Bot/webhook messages, ambient server chat, and messages rejected by access rules never reach this limit.

The sixth message receives a deterministic murloc reply with the seconds until the oldest accepted message leaves the window. This path calls no model, joins no model queue, and adds no conversation history. Rejected attempts do not extend the wait. Accepted messages count even if the model fails, the queue is busy, or the message is a local command such as `reset`; retries/redelivery of the same message ID are not charged twice within the window.

## Access controls

Access starts open. Optional comma-separated Discord ID lists in `.env` narrow it:

```dotenv
DISCORD_ALLOWED_GUILD_IDS=123456789
DISCORD_ALLOWED_CHANNEL_IDS=234567890
DISCORD_ALLOWED_USER_IDS=345678901,456789012
DISCORD_ALLOW_DMS=true
```

Every nonempty list must match. Channel lists accept either a thread ID or its parent channel ID. User restrictions apply to DMs too; guild and channel restrictions apply only to server messages. Set `DISCORD_ALLOW_DMS=false` to disable DMs. Restart after configuration changes. Role-based policies can be added at the connector’s single routing boundary later.

## Always-on server

Build with `npm ci && npm run build`. Copy [deploy/wow-bot.service](deploy/wow-bot.service) to `~/.config/systemd/user/wow-bot.service`. Edit `WorkingDirectory` to the checkout path and `ExecStart` to the absolute Node.js 24+ binary from `command -v node` (systemd does not load your shell’s nvm setup).

```sh
chmod 600 .env
systemctl --user daemon-reload
systemctl --user enable --now wow-bot
journalctl --user -u wow-bot -f
```

Enable user lingering if needed so it stays up after logout: `sudo loginctl enable-linger "$USER"`. Shutdown drains pending requests before closing Discord and SQLite. For upgrades, stop the service, install/build, then start it again.

Keep `.env` and `.data/` private. Back up `.data/` with the service stopped, including SQLite sidecar files if present. Conversation text is stored locally and sent to the model; it is not written to application logs.

## Code boundaries and validation

Run `npm run eval:scope` for the [prompt evaluation suite](evals/README.md). It saves actual replies and per-case rubrics in a reviewable HTML/JSON report. Mechanical checks are automatic; scope, usefulness, and personality are assessed by a reader. The suite uses synthetic data and the current OAuth login without posting to Discord.

`npm run test:tools:live` runs a [headless tool integration test](spikes/tools/README.md) with synthetic chat/pins and the current OAuth login. It checks actual tool execution, working callbacks, malicious quoted instructions, persistence, compaction/replay, and current time without posting to Discord.

`src/core/` coordinates conversations and storage without importing Discord. `src/agent.ts` owns model execution. `src/providers/chatgpt/` owns OAuth and inference transport, adapted from TriageBot. `src/connectors/discord/` translates messages, applies access policy, and delivers replies. Another connector can call the same `Conversations.handle()` interface with its own namespaced conversation IDs.

`npm run check` covers type checking, offline tests, and production compilation. Tests exercise OAuth callback validation and refresh rotation, the actual provider stream parser and tool loop, persistent history, ordering, delivery failures, access restrictions, routing, and message splitting. Live OAuth consent, account model access, and Discord delivery require your account and test-server bot credentials; offline checks cannot verify those.

An isolated [native compaction probe](spikes/compaction/README.md) is available as `npm run test:compaction:live`. `npm run test:compaction:integration` exercises the production agent, SQLite migration and archive, checkpoint persistence/replay, prefix stability, and per-user limit through a separate synthetic database. Both commands use the current OAuth login without connecting to Discord or changing production conversation history.
