// src/tools/salaryResearch.ts — research comp range for each role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";
import { trackTokens } from "../utils/tokenUsage";

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

const FALLBACK = (job: JobResult, notes: string): SalaryData => ({
  role: job.title, company: job.company,
  baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0,
  currency: "USD", sources: [], notes
});

const JSON_SCHEMA = `{
  "role": "...",
  "company": "...",
  "baseLow": 180000,
  "baseHigh": 220000,
  "tcLow": 280000,
  "tcHigh": 380000,
  "currency": "USD",
  "sources": ["job posting"],
  "notes": "brief note"
}`;

function parseSalaryJson(raw: string, job: JobResult): SalaryData | null {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as SalaryData;
  } catch {
    return null;
  }
}

export async function researchSalary(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<SalaryData> {
  const client = new Anthropic({ apiKey });

  const prompt = `
Visit this job posting URL and extract the salary or compensation range if it is listed on the page.

URL: ${job.url}
Role: ${job.title}
Company: ${job.company}
Location: ${job.location}

Instructions:
1. Visit the URL above and look for any salary, pay range, or compensation information on the page
2. If found on the page, extract the exact numbers and set sources to ["job posting"]
3. If the page has no salary info or the URL is inaccessible, estimate the range using your knowledge of this company and role — set sources to ["estimated"]
4. Use 0 for any field you cannot determine

Return ONLY this JSON object, no other text:
${JSON_SCHEMA}
`;

  const retries = 3;
  let lastError: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 512,
        system: "You are a compensation research expert. Visit job postings and extract or estimate salary ranges.",
        tools: [{ type: "web_search_20250305", name: "web_search" } as any],
        messages: [{ role: "user", content: prompt }]
      });

      trackTokens(response.usage);
      // web_search_20250305 is server-side — Anthropic handles tool execution.
      // We just read the final text response.
      let rawText = "";
      for (const block of response.content) {
        if (block.type === "text") rawText += block.text;
      }

      if (!rawText.trim()) return FALLBACK(job, "No response from model");

      const parsed = parseSalaryJson(rawText, job);
      return parsed ?? FALLBACK(job, "Could not parse salary response");

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
      return FALLBACK(job, `Error: ${err.message}`);
    }
  }

  return FALLBACK(job, "Max retries exceeded");
}

export function formatSalaryRange(data: SalaryData): string {
  const fmt = (n: number) => n > 0 ? `$${(n / 1000).toFixed(0)}k` : "N/A";
  const tag = data.sources.includes("job posting") ? " 📄" : data.sources.includes("estimated") ? " ~" : "";
  return `Base: ${fmt(data.baseLow)}–${fmt(data.baseHigh)} | TC: ${fmt(data.tcLow)}–${fmt(data.tcHigh)}${tag}`;
}
