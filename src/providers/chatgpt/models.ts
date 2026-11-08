import { z } from "zod";
import { getAccessToken } from "./auth.js";

export async function availableModels(authFile: string) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${await getAccessToken(authFile)}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}).`);
  return z.object({ models: z.array(z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() })) })
    .parse(await response.json()).models.filter(model => model.visibility === "list");
}
