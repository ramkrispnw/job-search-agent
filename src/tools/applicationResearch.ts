// src/tools/applicationResearch.ts — research application requirements for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";

export interface AppRequirements {
  coverLetterStatus: "required" | "recommended" | "optional" | "unknown";
  additionalQuestions: string[];
  notes: string;
}

const FALLBACK: AppRequirements = {
  coverLetterStatus: "unknown",
  additionalQuestions: [],
  notes: "Could not retrieve requirements"
};

export async function researchApplicationRequirements(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<AppRequirements> {
  const client = new Anthropic({ apiKey });

  const prompt = `
Visit this job posting URL and answer two questions about the application process.

URL: ${job.url}
Role: ${job.title} at ${job.company}

Questions:
1. Is a cover letter required, recommended, or optional? (check the posting for explicit instructions)
2. Are there any additional application questions beyond resume — e.g. "Why do you want to work here?", work authorization, salary expectations, portfolio links?

Return ONLY this JSON object, no other text:
{
  "coverLetterStatus": "required" | "recommended" | "optional" | "unknown",
  "additionalQuestions": ["question 1", "question 2"],
  "notes": "one line summary of what you found"
}

If the page is inaccessible or has no information, use "unknown" and an empty array.
`;

  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        system: "You visit job postings and extract application requirement details.",
        tools: [{ type: "web_search_20250305", name: "web_search" } as any],
        messages: [{ role: "user", content: prompt }]
      });

      let rawText = "";
      for (const block of response.content) {
        if (block.type === "text") rawText += block.text;
      }

      if (!rawText.trim()) return FALLBACK;

      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1) return FALLBACK;

      return JSON.parse(cleaned.slice(start, end + 1)) as AppRequirements;

    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < retries) {
        const delay = err?.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"], 10) * 1000
          : Math.min(60000, 15000 * Math.pow(2, attempt));
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      return { ...FALLBACK, notes: `Error: ${err.message}` };
    }
  }

  return FALLBACK;
}
