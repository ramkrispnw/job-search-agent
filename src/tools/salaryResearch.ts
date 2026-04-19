// src/tools/salaryResearch.ts — research comp range for each role

import Anthropic from "@anthropic-ai/sdk";
import * as https from "https";
import * as http from "http";
import { ask } from "../utils/claude";
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

const FALLBACK = (job: JobResult, notes: string): SalaryData => ({
  role: job.title, company: job.company,
  baseLow: 0, baseHigh: 0, tcLow: 0, tcHigh: 0,
  currency: "USD", sources: [], notes
});

// ─── Fetch job page text ──────────────────────────────────────────────────────

async function fetchPageText(url: string, maxBytes = 80_000): Promise<string> {
  return new Promise((resolve) => {
    const get = (targetUrl: string, redirects = 0) => {
      if (redirects > 5) return resolve("");
      // Resolve relative redirect URLs against the current URL
      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(targetUrl).href;
      } catch {
        return resolve(""); // unparseable URL — give up
      }
      const lib = resolvedUrl.startsWith("https") ? https : http;
      const req = lib.get(resolvedUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; job-search-agent/2.0)",
          "Accept": "text/html,application/xhtml+xml"
        }
      }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          const location = res.headers.location;
          // Resolve relative locations against the current URL
          const next = location.startsWith("http") ? location : new URL(location, resolvedUrl).href;
          return get(next, redirects + 1);
        }
        if ((res.statusCode ?? 0) >= 400) return resolve("");

        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          chunks.push(chunk);
          if (total >= maxBytes) req.destroy();
        });
        res.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          // Strip tags, collapse whitespace
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
            .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
            .replace(/\s{3,}/g, "\n\n")
            .trim()
            .slice(0, 6000);  // keep first ~6k chars — salary is usually near the top
          resolve(text);
        });
        res.on("error", () => resolve(""));
      });
      req.setTimeout(8000, () => { req.destroy(); resolve(""); });
      req.on("error", () => resolve(""));
    };
    get(url);
  });
}

// ─── Parse JSON from Claude response ─────────────────────────────────────────

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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function researchSalary(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<SalaryData> {
  // 1. Fetch the job posting page and try to extract salary from it
  const pageText = await fetchPageText(job.url);

  if (pageText) {
    const hasSalary = /\$[\d,]+|\d{2,3}[kK]\s*[-–]\s*\d{2,3}[kK]|salary|compensation|pay range/i.test(pageText);

    if (hasSalary) {
      const extractPrompt = `
Extract the salary / compensation information from this job posting text.

Role: ${job.title}
Company: ${job.company}
Location: ${job.location}

Job posting text:
${pageText}

Return ONLY a JSON object. Use 0 for any field you cannot determine.
${JSON_SCHEMA}

Return ONLY the JSON, no other text.`;

      const raw = await ask(apiKey, extractPrompt,
        "You extract structured salary data from job postings.",
        400, model, 2);

      const parsed = parseSalaryJson(raw, job);
      if (parsed && parsed.baseLow > 0) {
        parsed.sources = ["job posting"];
        return parsed;
      }
    }
  }

  // 2. Fall back to Claude's training knowledge — no web search, fast
  const estimatePrompt = `
Estimate the compensation range for this role based on your knowledge of the industry and company.
Do NOT search the web — use your training knowledge only.

Role: ${job.title}
Company: ${job.company}
Location: ${job.location}

Use typical ranges for this type of role at this company or comparable companies.
If the company is well-known (e.g. OpenAI, Anthropic, Google, Meta), use their known ranges.
Otherwise, estimate from comparable companies.

Return ONLY a JSON object:
${JSON_SCHEMA}

Set sources to ["estimated"]. Return ONLY the JSON, no other text.`;

  const raw = await ask(apiKey, estimatePrompt,
    "You are a compensation expert with knowledge of tech industry salary ranges.",
    400, model, 2);

  return parseSalaryJson(raw, job) ?? FALLBACK(job, "Could not estimate");
}

export function formatSalaryRange(data: SalaryData): string {
  const fmt = (n: number) => n > 0 ? `$${(n / 1000).toFixed(0)}k` : "N/A";
  const source = data.sources.includes("job posting") ? " 📄" : data.sources.includes("estimated") ? " ~" : "";
  return `Base: ${fmt(data.baseLow)}–${fmt(data.baseHigh)} | TC: ${fmt(data.tcLow)}–${fmt(data.tcHigh)}${source}`;
}
