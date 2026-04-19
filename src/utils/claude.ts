// src/utils/claude.ts — thin wrapper around Anthropic SDK

import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getClient(apiKey: string): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";

export async function ask(
  apiKey: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4096,
  model = DEFAULT_MODEL,
  retries = 4,
  cachedPrefix?: string,  // content to cache (e.g. resume text) — cache reads don't count toward rate limits
  onWait?: (seconds: number, attempt: number) => void  // callback so callers can update their spinner
): Promise<string> {
  const client = getClient(apiKey);

  const userContent: Anthropic.MessageParam["content"] = cachedPrefix
    ? [
        { type: "text", text: cachedPrefix, cache_control: { type: "ephemeral" } } as any,
        { type: "text", text: prompt }
      ]
    : prompt;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userContent }
  ];

  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt ?? "You are a helpful career coach and expert resume writer.",
        messages
      });

      const block = response.content[0];
      if (block.type !== "text") throw new Error("Unexpected response type from Claude");
      return block.text;
    } catch (err: any) {
      lastError = err;
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < retries) {
        // Use retry-after header if available, otherwise back off toward 60s
        const retryAfter = err?.headers?.["retry-after"];
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(60000, 15000 * Math.pow(2, attempt)); // 15s, 30s, 60s, 60s
        const seconds = Math.round(delay / 1000);
        if (onWait) {
          onWait(seconds, attempt + 1);
        } else {
          process.stderr.write(`\r  Rate limited — waiting ${seconds}s before retry ${attempt + 1}/${retries}...`);
        }
        await new Promise(res => setTimeout(res, delay));
        if (!onWait) process.stderr.write("\r" + " ".repeat(60) + "\r");
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
