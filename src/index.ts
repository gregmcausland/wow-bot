import "dotenv/config";
import { readConfig } from "./config.js";
import { createAgent } from "./agent.js";
import { Conversations } from "./core/conversation.js";
import { SqliteConversationStore } from "./core/store.js";
import { createDiscordConnector } from "./connectors/discord/connector.js";
import { getAccessToken } from "./providers/chatgpt/auth.js";
import { createChatGPTModel } from "./providers/chatgpt/model.js";

async function main() {
  const config = readConfig();
  await getAccessToken(config.authFile);
  const store = new SqliteConversationStore(config.databaseFile);
  const agent = createAgent(createChatGPTModel(config.authFile, config.model), config.botName, config.reasoning, config.compactThreshold);
  const discord = createDiscordConnector(new Conversations(agent, store), config.access);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.info("Stopping after pending conversations finish.");
    void discord.stop().finally(() => store.close()).catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try { await discord.start(config.discordToken); }
  catch (error) { await discord.stop(); store.close(); throw error; }
}

main().catch(() => {
  console.error("Bot startup failed. Check .env, npm run auth:status, and Discord bot permissions.");
  process.exitCode = 1;
});
