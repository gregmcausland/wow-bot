import "dotenv/config";
import { spawn } from "node:child_process";
import { readModelConfig } from "./config.js";
import { login, readAuth, updateAuth } from "./providers/chatgpt/auth.js";
import { availableModels } from "./providers/chatgpt/models.js";

async function main() {
  const { authFile } = readModelConfig();
  const command = process.argv[2] ?? "status";
  if (command === "models") {
    for (const model of await availableModels(authFile)) console.info(`${model.slug}\t${model.display_name}`);
  } else if (command === "status") {
    const state = await readAuth(authFile);
    console.info(state?.credentials
      ? `ChatGPT connected. Access token ${state.credentials.expiresAt <= Date.now() + 300_000 ? "will refresh on the next request" : "is current"}.`
      : "ChatGPT is not connected. Run npm run auth:login.");
  } else if (command === "logout") {
    await updateAuth(authFile, async state => { delete state.credentials; delete state.idToken; });
    console.info("Removed local ChatGPT tokens. This does not revoke the grant at OpenAI.");
  } else if (command === "login") {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once("SIGINT", cancel);
    try {
      await login(authFile, url => {
        console.info(`Continue with ChatGPT: ${url}`);
        const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
        const browser = spawn(program, [url], { stdio: "ignore" });
        browser.on("error", () => {}); browser.unref();
      }, AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]), {
        listenHost: process.env.AUTH_LOGIN_HOST, publicOrigin: process.env.AUTH_LOGIN_ORIGIN,
      });
      console.info("ChatGPT connected. Credentials are stored locally and refresh automatically.");
    } finally { process.removeListener("SIGINT", cancel); }
  } else {
    throw new Error("Use login, status, logout, or models.");
  }
}

main().catch(error => {
  console.error(error instanceof Error && error.name !== "ZodError" ? error.message : "Authentication failed.");
  process.exitCode = 1;
});
