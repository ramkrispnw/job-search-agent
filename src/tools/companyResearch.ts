// src/tools/companyResearch.ts — research company context before tailoring

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";

export interface CompanyBrief {
  recentNews: string;         // recent launches, funding, news
  productDirection: string;   // where the product is heading
  cultureSignals: string;     // what they value, how they work
  whyHiringNow: string;       // what problem this role solves
  talkingPoints: string[];    // 2-3 specific details to reference in application
}

export async function researchCompany(
  apiKey: string,
  job: JobResult,
  model: string
): Promise<CompanyBrief> {
  const client = new Anthropic({ apiKey });

  const prompt = `
Research ${job.company} to build a brief that will help a candidate write a highly targeted application
for the role: ${job.title}.

Search for:
1. Recent product launches, company news, or funding in the last 6 months
2. Where their product is heading — roadmap signals, engineering blog, CEO interviews
3. Culture and what they reward — interview process signals, Glassdoor themes, leadership style
4. Why they are hiring for this specific role right now — what problem are they solving?

Role context: ${job.description}

Return ONLY this JSON structure:
{
  "recentNews": "1-2 sentences on the most relevant recent news or launches",
  "productDirection": "1-2 sentences on where the product is heading",
  "cultureSignals": "1-2 sentences on culture, what they reward, how they work",
  "whyHiringNow": "1-2 sentences on what problem this role is solving right now",
  "talkingPoints": [
    "specific detail 1 worth referencing in the application",
    "specific detail 2 worth referencing in the application"
  ]
}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search" } as any],
      messages: [{ role: "user", content: prompt }]
    });

    const raw = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");

    const cleaned = raw.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1) {
      return JSON.parse(cleaned.slice(start, end + 1)) as CompanyBrief;
    }
  } catch { /* fall through to default */ }

  return {
    recentNews: "No recent news found",
    productDirection: job.description,
    cultureSignals: "Not available",
    whyHiringNow: job.whyItFits,
    talkingPoints: []
  };
}
