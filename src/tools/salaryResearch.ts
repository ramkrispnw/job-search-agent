// src/tools/salaryResearch.ts — research comp range for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch.js";

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

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    tools: [{ type: "web_search_20250305", name: "web_search" } as any],
    messages: [{ role: "user", content: prompt }]
  });

  let rawText = "";
  for (const block of response.content) {
    if (block.type === "text") rawText += block.text;
  }

  const cleaned = rawText.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1) {
    return {
      role: job.title, company: job.company,
      baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0,
      currency: "USD", sources: [], notes: "Could not retrieve salary data"
    };
  }

  return JSON.parse(cleaned.slice(start, end + 1)) as SalaryData;
}

export function formatSalaryRange(data: SalaryData): string {
  const fmt = (n: number) => n > 0 ? `$${(n / 1000).toFixed(0)}k` : "N/A";
  return `Base: ${fmt(data.baseLow)}–${fmt(data.baseHigh)} | TC: ${fmt(data.tcLow)}–${fmt(data.tcHigh)}`;
}
