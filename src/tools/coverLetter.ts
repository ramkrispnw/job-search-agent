// src/tools/coverLetter.ts — generate a tailored cover letter per role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";
import { CompanyBrief } from "./companyResearch";
import { PositioningStrategy } from "./positioningStrategy";

export async function generateCoverLetter(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  candidateName: string,
  model: string,
  onWait?: (seconds: number, attempt: number) => void,
  companyBrief?: CompanyBrief,
  strategy?: PositioningStrategy
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const today = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric"
  });

  const coverLetterAllocation = strategy?.storyAllocation.find(s => s.slot === "cover letter");

  const strategyBlock = strategy ? `
## Positioning Strategy (follow this exactly)
Narrative angle: ${strategy.narrativeAngle}
Story to use as hook: ${coverLetterAllocation?.story ?? "most impressive relevant experience"}
How to frame it: ${coverLetterAllocation?.angle ?? "direct match to role requirements"}
Keywords to include: ${strategy.keywordsToHit.join(", ")}
` : "";

  const companyBlock = companyBrief ? `
## Company Intelligence (use this to make the letter specific — not generic)
Recent news: ${companyBrief.recentNews}
Product direction: ${companyBrief.productDirection}
Culture signals: ${companyBrief.cultureSignals}
Why they're hiring now: ${companyBrief.whyHiringNow}
Specific talking points to reference: ${companyBrief.talkingPoints.join("; ")}
` : "";

  const prompt = `
Write a concise, compelling cover letter for the candidate (resume provided above) applying to this role.
This cover letter is ONE artifact in a set — the resume establishes facts and bullets,
the cover letter adds narrative and "why this company". Do not repeat resume bullets verbatim.

## Target Role
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${strategyBlock}${companyBlock}
## Writing Instructions
- 3 paragraphs max, ~250 words total
- Opening: reference a SPECIFIC detail about ${job.company} from the company intelligence above
  (a recent launch, their product direction, something that shows you've done your homework)
  — NOT generic "I am excited to apply"
- Middle: use the allocated story/hook from the strategy — frame it around the narrative angle
  Include 1-2 concrete metrics from the resume where available
- Closing: confident call to action, no cringe phrases
- Tone: confident, direct, human — not corporate fluff
- Do NOT fabricate achievements or metrics not in the resume
- Do NOT repeat stories that will also appear in question answers

Start with:
${today}

${candidateName}
[email] | [phone] | [LinkedIn]

Hiring Team, ${job.company}

Re: ${job.title}
`;

  let attempt = 0;
  const maxRetries = 4;
  const backoff = [15000, 30000, 60000, 60000];

  while (true) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `## Candidate Resume\n${resumeText}`, cache_control: { type: "ephemeral" } } as any,
            { type: "text", text: prompt }
          ]
        }],
        system: "You are an expert cover letter writer. Be direct, specific, human. Show genuine company knowledge."
      });

      return response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("rate_limit");
      if (isRateLimit && attempt < maxRetries) {
        const delay = err?.headers?.["retry-after"]
          ? parseInt(err.headers["retry-after"]) * 1000
          : backoff[attempt];
        const seconds = Math.round(delay / 1000);
        if (onWait) onWait(seconds, attempt + 1);
        await new Promise(r => setTimeout(r, delay));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}
