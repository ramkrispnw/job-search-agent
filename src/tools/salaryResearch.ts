// src/tools/salaryResearch.ts — research comp range for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";

export interface SalaryData {
  role: string;
  company: string;
  baseLow: number;
  baseHigh: number;
  tcLow: number;
  tcHigh: number;
  currency: string;
  sources: string[];
  notes: string;
}

const FALLBACK: (job: JobResult, notes: string) => SalaryData = (job, notes) => ({
  role: job.title, company: job.company,
  baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0,
  currency: "USD", sources: [], notes
});

export async function researchSalary(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<SalaryData> {
  const client = new Anthropic({ apiKey });

  const prompt = `
Research the compensation range for this specific role. Use web search to find:
- Levels.fyi data for ${job.company} if available
- Glassdoor / LinkedIn salary data
- Recent job postings with disclosed salary bands
- Any public comp data for ${job.title} at ${job.company} or comparable companies

Role: ${job.title}
Company: ${job.company}
Location: ${job.location}

Return ONLY a JSON object with this structure:
{
  "role": "${job.title}",
  "company": "${job.company}",
  "baseLow": 180000,
  "baseHigh": 220000,
  "tcLow": 280000,
  "tcHigh": 380000,
  "currency": "USD",
  "sources": ["levels.fyi", "glassdoor"],
  "notes": "Senior IC range at FAANG-tier; equity vest 4yr cliff"
}

Use round numbers. If data is unavailable, estimate from comparable companies and note it.
Return ONLY the JSON object, no other text.
`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const retries = 4;
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search" } as any],
        messages
      });

      // Handle multi-turn: if Claude used the web_search tool, send back tool results
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
        continue; // loop back to get final text response
      }

      let rawText = "";
      for (const block of response.content) {
        if (block.type === "text") rawText += block.text;
      }

      const cleaned = rawText.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1) return FALLBACK(job, "Could not parse salary data");

      return JSON.parse(cleaned.slice(start, end + 1)) as SalaryData;

    } catch (err: any) {
      lastError = err;
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < retries) {
        const retryAfter = err?.headers?.["retry-after"];
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(60000, 15000 * Math.pow(2, attempt));
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export function formatSalaryRange(data: SalaryData): string {
  const fmt = (n: number) => n > 0 ? `$${(n / 1000).toFixed(0)}k` : "N/A";
  return `Base: ${fmt(data.baseLow)}–${fmt(data.baseHigh)} | TC: ${fmt(data.tcLow)}–${fmt(data.tcHigh)}`;
}
