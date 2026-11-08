import { resolve } from "node:path";
import { z } from "zod";

const modelSchema = z.object({
  AI_MODEL: z.string().trim().min(1).default("gpt-6.1-sol"),
  AI_REASONING: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).default("low"),
  AUTH_FILE: z.string().trim().min(1).default(".data/auth.json"),
  AI_COMPACT_THRESHOLD: z.coerce.number().int().min(2048).max(1_000_000).default(24_000),
});

export function readModelConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = modelSchema.parse(env);
  return { model: config.AI_MODEL, reasoning: config.AI_REASONING, authFile: resolve(config.AUTH_FILE), compactThreshold: config.AI_COMPACT_THRESHOLD };
}

const idList = z.string().default("").transform(value => value.split(",").map(id => id.trim()).filter(Boolean))
  .pipe(z.array(z.string().regex(/^\d+$/, "Use comma-separated Discord IDs")))
  .transform(ids => new Set(ids));

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = z.object({
    DISCORD_BOT_TOKEN: z.string().trim().min(1),
    BOT_NAME: z.string().trim().min(1).default("WoW Bot"),
    DATABASE_FILE: z.string().trim().min(1).default(".data/conversations.sqlite"),
    DISCORD_ALLOWED_GUILD_IDS: idList,
    DISCORD_ALLOWED_CHANNEL_IDS: idList,
    DISCORD_ALLOWED_USER_IDS: idList,
    DISCORD_ALLOW_DMS: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
  }).parse(env);
  return {
    ...readModelConfig(env), botName: config.BOT_NAME, discordToken: config.DISCORD_BOT_TOKEN,
    databaseFile: resolve(config.DATABASE_FILE),
    access: { guildIds: config.DISCORD_ALLOWED_GUILD_IDS, channelIds: config.DISCORD_ALLOWED_CHANNEL_IDS,
      userIds: config.DISCORD_ALLOWED_USER_IDS, allowDMs: config.DISCORD_ALLOW_DMS },
  };
}
