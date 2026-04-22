// src/tools/questionAnswers.ts — generate answers to application questions

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";
import { trackTokens } from "../utils/tokenUsage";
import { CompanyBrief } from "./companyResearch";
import { PositioningStrategy } from "./positioningStrategy";

type QuestionType = "behavioral" | "motivational" | "skills" | "values" | "logistical";

function classifyQuestion(q: string): QuestionType {
  const lower = q.toLowerCase();
  if (/tell me about a time|describe a situation|give an example|walk me through|share a time/i.test(lower)) return "behavioral";
  if (/why (this company|us|here|do you want)|what excites|what draws|interest in/i.test(lower)) return "motivational";
  if (/describe your (approach|experience|process|framework)|how do you|what is your strategy/i.test(lower)) return "skills";
  if (/what (matters|do you value|do you believe)|how do you think about|philosophy/i.test(lower)) return "values";
  return "logistical";
}

function formatInstructions(type: QuestionType, companyBrief?: CompanyBrief): string {
  switch (type) {
    case "behavioral":
      return "Use STAR format (Situation, Task, Action, Result). Be specific — name the project, company, and outcome with metrics. Keep under 200 words.";
    case "motivational":
      return `Reference a SPECIFIC and RECENT detail about the company — not generic enthusiasm. Use: ${companyBrief?.talkingPoints?.join("; ") ?? "company mission and product direction"}. Show you've done your homework. Under 150 words.`;
    case "skills":
      return "Describe your actual framework or approach with a concrete example. Avoid abstract claims — show, don't tell. Under 200 words.";
    case "values":
      return `Align with the company's culture signals: ${companyBrief?.cultureSignals ?? "what they value"}. Be authentic — connect to real experience. Under 150 words.`;
    case "logistical":
      return "Answer directly and concisely. Under 100 words.";
  }
}

export async function generateQuestionAnswers(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  questions: string[],
  candidateName: string,
  model: string,
  onWait?: (seconds: number, attempt: number) => void,
  companyBrief?: CompanyBrief,
  strategy?: PositioningStrategy,
  coverLetterSummary?: string  // brief summary of what the cover letter covered, to avoid repetition
): Promise<Record<string, string>> {
  if (questions.length === 0) return {};

  const client = new Anthropic({ apiKey });

  const classified = questions.map(q => ({
    question: q,
    type: classifyQuestion(q),
    allocation: strategy?.storyAllocation.find(s => s.slot === q)
  }));

  const avoidRepetition = coverLetterSummary
    ? `\n## Already Covered in Cover Letter (do NOT repeat these stories)\n${coverLetterSummary}\n`
    : "";

  const strategyBlock = strategy ? `
## Positioning Strategy
Narrative angle: ${strategy.narrativeAngle}
Keywords to weave in: ${strategy.keywordsToHit.join(", ")}
` : "";

  const companyBlock = companyBrief ? `
## Company Intelligence
Recent news: ${companyBrief.recentNews}
Culture signals: ${companyBrief.cultureSignals}
Why hiring now: ${companyBrief.whyHiringNow}
Specific talking points: ${companyBrief.talkingPoints.join("; ")}
` : "";

  const questionsBlock = classified.map((c, i) => {
    const allocation = c.allocation
      ? `\n   Story to use: ${c.allocation.story}\n   Angle: ${c.allocation.angle}`
      : "";
    return `${i + 1}. [${c.type.toUpperCase()}] ${c.question}
   Instructions: ${formatInstructions(c.type, companyBrief)}${allocation}`;
  }).join("\n\n");

  const prompt = `
The candidate (resume above) is applying for ${job.title} at ${job.company}.
Answer each application question below. These answers are part of a set — the resume covers facts,
the cover letter tells the main narrative story. These answers must each use a DIFFERENT story/example
and must not repeat what is already in the cover letter.
${avoidRepetition}${strategyBlock}${companyBlock}
## Questions
${questionsBlock}

## Rules
- Ground every answer in the resume — do not fabricate
- Each answer uses a different story/experience (no repetition across answers or cover letter)
- Behavioral answers: use STAR format with specific metrics
- Motivational answers: reference a specific recent company detail, not generic enthusiasm
- Be direct and confident — no filler phrases

Return ONLY a JSON object:
{
  "exact question text": "answer text",
  ...
}`;

  let attempt = 0;
  const maxRetries = 4;
  const backoff = [15000, 30000, 60000, 60000];

  while (true) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 2000,
        system: `You are a career coach helping ${candidateName} write authentic, specific application answers.`,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `## Candidate Resume\n${resumeText}`, cache_control: { type: "ephemeral" } } as any,
            { type: "text", text: prompt }
          ]
        }]
      });
      trackTokens(response.usage);

      const raw = response.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      const cleaned = raw.replace(/```json|```/g, "").trim();
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start === -1) return {};
      return JSON.parse(cleaned.slice(start, end + 1));
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
