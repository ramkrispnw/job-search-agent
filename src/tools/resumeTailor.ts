// src/tools/resumeTailor.ts — generate a tailored resume for a specific role

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";
import { trackTokens } from "../utils/tokenUsage";
import { PositioningStrategy } from "./positioningStrategy";

export async function tailorResume(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  model: string,
  onWait?: (seconds: number, attempt: number) => void,
  strategy?: PositioningStrategy
): Promise<string> {
  const client = new Anthropic({ apiKey });

  const strategyBlock = strategy ? `
## Positioning Strategy (follow this — it was reasoned carefully before this step)
Narrative angle: ${strategy.narrativeAngle}

Top matches to emphasize:
${strategy.topMatches.map(m => `- ${m}`).join("\n")}

Gaps to minimize:
${strategy.gapsToMinimize.map(g => `- ${g}`).join("\n")}

Keywords to include: ${strategy.keywordsToHit.join(", ")}

What to cut or downplay:
${strategy.whatToCut.map(w => `- ${w}`).join("\n")}

Resume bullets story allocation: ${strategy.storyAllocation.find(s => s.slot === "resume bullets")?.angle ?? "lead with most relevant experience"}
` : "";

  const prompt = `
You are an expert resume writer. Rewrite the candidate's resume (provided above) tailored specifically
for the role below. Follow the positioning strategy exactly — it was reasoned carefully to ensure
this resume, the cover letter, and all question answers tell a coherent, non-repetitive story.

## Target Role
Title: ${job.title}
Company: ${job.company}
Description: ${job.description}
${strategyBlock}
## Writing Instructions
- Keep all factual information accurate — do NOT invent experience or metrics
- Lead with the narrative angle from the strategy in the professional summary
- Reorder and reframe bullets to emphasize the top matches identified above
- Include all keywords naturally — critical for ATS parsing
- Cut or minimize what the strategy says to cut
- Keep total length to 1 page equivalent (~600 words max)

## ATS Compliance Rules (strictly follow)
- Standard section headers: Summary, Experience, Education, Skills
- No tables, columns, text boxes, or graphics — plain linear structure only
- Dates: consistent format "Month YYYY – Month YYYY"
- Simple bullet points (- ) only, no nested bullets
- Bold only names, titles, company names — no decorative bold
- No headers/footers, no page numbers
- Spell out abbreviations on first use

Return the full tailored resume in Markdown. Start with the candidate's name as an H1.
`;

  // Use extended thinking for the model that supports it (opus preferred, sonnet fallback)
  const thinkingModel = model.includes("opus") ? model : model;

  let attempt = 0;
  const maxRetries = 4;
  const backoff = [15000, 30000, 60000, 60000];

  while (true) {
    try {
      const response = await client.messages.create({
        model: thinkingModel,
        max_tokens: 5000,
        thinking: { type: "enabled", budget_tokens: 3000 } as any,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `## Candidate Resume\n${resumeText}`, cache_control: { type: "ephemeral" } } as any,
            { type: "text", text: prompt }
          ]
        }]
      });

      trackTokens(response.usage);
      const text = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      return text;
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
