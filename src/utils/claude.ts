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
  model = DEFAULT_MODEL
): Promise<string> {
  const client = getClient(apiKey);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt }
  ];

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt ?? "You are a helpful career coach and expert resume writer.",
    messages
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type from Claude");
  return block.text;
}
