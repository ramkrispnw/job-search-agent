// src/tools/applicationResearch.ts — research application requirements for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";

export interface AppRequirements {
  coverLetterStatus: "required" | "recommended" | "optional" | "unknown";
  additionalQuestions: string[];  // e.g. ["Why do you want to work here?", "Describe a time you..."]
  notes: string;
}

export async function researchApplicationRequirements(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<AppRequirements> {
  const client = new Anthropic({ apiKey });

  const prompt = `
Research the application process for this specific job posting.

Role: ${job.title}
Company: ${job.company}
Location: ${job.location}
Posting URL: ${job.url}

Search for the actual job posting and answer:
1. Is a cover letter required, recommended, or optional? (check the posting for explicit instructions)
2. Are there any additional application questions (beyond resume) — e.g. "Why do you want to work at X?", "Describe a relevant project", work authorization, salary expectations, etc.

Return ONLY a JSON object:
{
  "coverLetterStatus": "required" | "recommended" | "optional" | "unknown",
  "additionalQuestions": ["question 1", "question 2"],
  "notes": "brief note on what you found — e.g. Greenhouse form with 3 custom questions"
}

If the posting URL is unavailable or you cannot find specifics, set coverLetterStatus to "unknown" and additionalQuestions to [].
Return ONLY the JSON object, no other text.
`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const retries = 3;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        tools: [{ type: "web_search_20250305", name: "web_search" } as any],
        messages
      });

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        messages.push({ role: "assistant", content: response.content });
        messages.push({
          role: "user",
          content: toolUseBlocks.map(b => ({
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: "Search completed."
          }))
        });
        continue;
      }

      let rawText = "";
      for (const block of response.content) {
        if (block.type === "text") rawText += block.text;
      }

      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1) return { coverLetterStatus: "unknown", additionalQuestions: [], notes: "Could not parse response" };

      return JSON.parse(cleaned.slice(start, end + 1)) as AppRequirements;

    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < retries) {
        const retryAfter = err?.headers?.["retry-after"];
        const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : Math.min(60000, 15000 * Math.pow(2, attempt));
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      return { coverLetterStatus: "unknown", additionalQuestions: [], notes: `Error: ${err.message}` };
    }
  }

  return { coverLetterStatus: "unknown", additionalQuestions: [], notes: "Max retries exceeded" };
}
