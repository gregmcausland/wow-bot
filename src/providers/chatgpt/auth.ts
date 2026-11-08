import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { lock } from "proper-lockfile";
import { z } from "zod";

const AUTH_ORIGIN = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const scopes = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const jwks = createRemoteJWKSet(new URL(`${AUTH_ORIGIN}/.well-known/jwks.json`));

const stateSchema = z.object({
  hostId: z.string().startsWith("urn:uuid:"),
  clientId: z.string().optional(),
  subject: z.string().optional(),
  idToken: z.string().optional(),
  credentials: z.object({
    accessToken: z.string().min(1), refreshToken: z.string().min(1),
    expiresAt: z.number(), scopes: z.array(z.string()),
  }).optional(),
});
export type AuthState = z.infer<typeof stateSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(), scope: z.string().optional(), id_token: z.string().optional(),
});

export async function readAuth(path: string): Promise<AuthState | undefined> {
  try { return stateSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("The ChatGPT credential file is invalid; move it aside and sign in again.");
  }
}

export async function updateAuth<T>(path: string, update: (state: AuthState) => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lock(path, {
    realpath: false, stale: 60_000, retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
  });
  try {
    const state = await readAuth(path) ?? { hostId: `urn:uuid:${randomUUID()}` };
    const result = await update(state);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
    return result;
  } finally { await release(); }
}

async function exchange(body: URLSearchParams, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(`${AUTH_ORIGIN}/api/accounts/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    // Do not include raw token-endpoint responses in errors or logs.
    throw new Error(`OAuth token exchange failed (HTTP ${response.status}). Sign in again if the grant expired.`);
  }
  return tokenSchema.parse(await response.json());
}

function saveTokens(state: AuthState, token: z.infer<typeof tokenSchema>) {
  const grantedScopes = token.scope?.split(/\s+/).filter(Boolean) ?? state.credentials?.scopes ?? [];
  if (!grantedScopes.includes(PLAN_SCOPE)) throw new Error("ChatGPT plan usage was not granted. Enable it during sign-in.");
  const refreshToken = token.refresh_token ?? state.credentials?.refreshToken;
  if (!refreshToken) throw new Error("OAuth did not return a refresh token.");
  state.credentials = {
    accessToken: token.access_token, refreshToken,
    expiresAt: Date.now() + token.expires_in * 1000, scopes: grantedScopes,
  };
}

export async function getAccessToken(path: string, fetcher: typeof fetch = fetch): Promise<string> {
  return updateAuth(path, async state => {
    if (!state.clientId || !state.credentials) throw new Error("Sign in first: npm run auth:login");
    if (state.credentials.expiresAt <= Date.now() + 5 * 60_000) {
      const token = await exchange(new URLSearchParams({
        grant_type: "refresh_token", client_id: state.clientId,
        refresh_token: state.credentials.refreshToken, resource: RESOURCE,
      }), fetcher);
      saveTokens(state, token);
    }
    return state.credentials!.accessToken;
  });
}

/** Starts loopback OAuth; only the user completes authentication/consent. */
export async function login(
  path: string,
  onReady: (url: string) => void,
  signal: AbortSignal,
  options: { listenHost?: string; publicOrigin?: string } = {},
) {
  const publicOrigin = options.publicOrigin ? new URL(options.publicOrigin) : undefined;
  if (publicOrigin && (publicOrigin.protocol !== "https:" || publicOrigin.href !== `${publicOrigin.origin}/`)) {
    throw new Error("AUTH_LOGIN_ORIGIN must be an HTTPS origin without a path, credentials, or query.");
  }
  const saved = await updateAuth(path, async state => structuredClone(state));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const expectedState = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let resolveCallback!: (value: { code: string; clientId: string }) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<{ code: string; clientId: string }>((resolve, reject) => {
    resolveCallback = resolve; rejectCallback = reject;
  });
  // Attach a rejection handler before the listener can receive a cancellation.
  void callback.catch(() => {});
  let redirectUri = "";
  let authorizationUrl = "";
  let entryUrl = "";
  function acceptCallback(url: URL, response: ServerResponse) {
    if (url.searchParams.get("state") !== expectedState) {
      response.writeHead(400).end("Invalid OAuth state. Use the original sign-in link.");
      return;
    }
    if (url.searchParams.has("error")) {
      response.writeHead(400).end("ChatGPT sign-in was declined or failed.");
      rejectCallback(new Error("ChatGPT sign-in was declined or failed."));
      return;
    }
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("client_id") ?? saved.clientId;
    if (!code || !clientId || clientId === "dynamic_agent_client" || (saved.clientId && saved.clientId !== clientId)) {
      response.writeHead(400).end("Invalid OAuth registration callback.");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Authorization received. Check your terminal for verification and test results.");
    resolveCallback({ code, clientId });
  }
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", entryUrl);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Referrer-Policy", "no-referrer");
      if (url.pathname === "/" && request.method === "GET") {
        response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ChatGPT for WoW Bot</title>
<style>body{font:16px/1.6 system-ui;max-width:650px;margin:48px auto;padding:0 24px}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0}button,a{font:inherit}button{padding:10px 16px}code{overflow-wrap:anywhere}</style>
<h1>Connect ChatGPT</h1>
<p>1. <a href="/start" target="_blank" rel="noopener noreferrer">Continue with ChatGPT</a> and allow plan usage.</p>
<p>2. OpenAI returns you to <code>${redirectUri}</code>. On another computer, that page may fail to load. Copy its full address from the browser address bar.</p>
<p>3. Paste that address below to return the authorization to WoW Bot. Keep this page open while signing in.</p>
<form method="post" action="/complete"><label for="callback">Full localhost redirect URL</label>
<input id="callback" name="callback" type="url" autocomplete="off" spellcheck="false" required>
<button type="submit">Complete connection</button></form>
<p>The redirect is sent directly to WoW Bot. Don’t paste it into chat. Check the terminal for the final test results.</p></html>`);
        return;
      }
      if (url.pathname === "/start" && request.method === "GET") {
        response.writeHead(302, { Location: authorizationUrl }).end();
        return;
      }
      if (url.pathname === "/complete" && request.method === "POST") {
        if (request.headers.origin !== new URL(entryUrl).origin) {
          response.writeHead(403).end("Submit the redirect using the original connection page.");
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 16_384) { response.writeHead(413).end("Redirect URL is too long."); return; }
        }
        let callbackUrl: URL;
        try { callbackUrl = new URL(new URLSearchParams(body).get("callback") ?? ""); }
        catch { response.writeHead(400).end("Paste the full localhost redirect URL."); return; }
        const expected = new URL(redirectUri);
        if (callbackUrl.origin !== expected.origin || callbackUrl.pathname !== expected.pathname) {
          response.writeHead(400).end("The redirect must match this sign-in's localhost callback address.");
          return;
        }
        acceptCallback(callbackUrl, response);
        return;
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        acceptCallback(url, response);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Could not process the callback. Retry from the connection page.");
    });
  });
  const cancel = () => rejectCallback(new Error("Sign-in cancelled or timed out."));
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, options.listenHost ?? "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start the OAuth callback.");
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    entryUrl = publicOrigin ? `${publicOrigin.origin}/` : `http://${options.listenHost ?? "127.0.0.1"}:${address.port}/`;
    const parameters = new URLSearchParams({
      client_id: saved.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: saved.hostId, response_type: "code", redirect_uri: redirectUri,
      resource: RESOURCE, scope: scopes, state: expectedState, nonce,
      code_challenge: challenge, code_challenge_method: "S256",
    });
    if (!saved.clientId) parameters.set("agent_name_hint", "WoW Bot");
    if (saved.idToken) parameters.set("id_token_hint", saved.idToken);
    authorizationUrl = `${AUTH_ORIGIN}/api/accounts/authorize?${parameters}`;
    signal.throwIfAborted();
    // This local URL contains no tokens or login hints and is safe to print.
    onReady(entryUrl);
    const result = await callback;
    await updateAuth(path, async state => { state.clientId = result.clientId; });
    const token = await exchange(new URLSearchParams({
      grant_type: "authorization_code", client_id: result.clientId, code: result.code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE,
    }), fetch, signal);
    if (!token.id_token) throw new Error("OAuth did not return an ID token.");
    const { payload } = await jwtVerify(token.id_token, jwks, {
      issuer: AUTH_ORIGIN, audience: result.clientId, requiredClaims: ["sub", "exp", "nonce"],
    });
    if (payload.nonce !== nonce) throw new Error("ID token nonce did not match this sign-in.");
    if (saved.subject && payload.sub !== saved.subject) throw new Error("The signed-in account does not match the saved registration.");
    await updateAuth(path, async state => {
      state.clientId = result.clientId; state.subject = payload.sub; state.idToken = token.id_token;
      saveTokens(state, token);
    });
  } finally {
    signal.removeEventListener("abort", cancel);
    server.close(); server.closeAllConnections();
  }
}
