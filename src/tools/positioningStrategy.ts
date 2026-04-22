// src/tools/positioningStrategy.ts — build a positioning strategy before any writing

import Anthropic from "@anthropic-ai/sdk";
import { JobResult } from "./webSearch";
import { CompanyBrief } from "./companyResearch";
import { AppRequirements } from "./applicationResearch";

export interface StoryAllocation {
  slot: string;       // "resume" | "cover_letter" | question text
  story: string;      // which experience/story to use
  angle: string;      // how to frame it for this slot
}

export interface PositioningStrategy {
  narrativeAngle: string;         // the single strongest hook for this candidate + role
  topMatches: string[];           // top 3 experiences that map to requirements (with reasoning)
  gapsToMinimize: string[];       // gaps and how to frame/minimize them
  keywordsToHit: string[];        // must-include keywords from JD + company context
  storyAllocation: StoryAllocation[]; // which story goes in which slot (no repeats)
  whatToCut: string[];            // irrelevant experience to omit or downplay
}

export async function buildPositioningStrategy(
  apiKey: string,
  resumeText: string,
  job: JobResult,
  companyBrief: CompanyBrief,
  appRequirements: AppRequirements,
  model: string
): Promise<PositioningStrategy> {
  const client = new Anthropic({ apiKey });

  const slots = [
    "resume bullets",
    "cover letter",
    ...appRequirements.additionalQuestions
  ];

  const prompt = `
You are a senior career strategist. Before any writing happens, build a positioning strategy
for this candidate applying to this role. Your strategy will drive the resume, cover letter,
and all application question answers — so every artifact tells a coherent, non-repetitive story.

## Candidate Resume
${resumeText}

## Target Role
Title: ${job.title}
Company: ${job.company}
Description: ${job.description}
Alignment score: ${job.alignmentScore}/10

## Company Intelligence
Recent news: ${companyBrief.recentNews}
Product direction: ${companyBrief.productDirection}
Culture signals: ${companyBrief.cultureSignals}
Why hiring now: ${companyBrief.whyHiringNow}
Key talking points: ${companyBrief.talkingPoints.join("; ")}

## Application Artifacts Needed
Cover letter: ${appRequirements.coverLetterStatus}
Additional questions:
${appRequirements.additionalQuestions.length > 0
  ? appRequirements.additionalQuestions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")
  : "  None"}

## Slots to fill (each must use a DIFFERENT story/example — no repeats across slots)
${slots.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}

## Your Task
Reason carefully about:
1. What is the single strongest narrative angle for THIS candidate at THIS company right now?
2. Which 3 experiences from the resume are the strongest matches — and why?
3. What gaps exist and how should they be minimized or reframed?
4. Which keywords from the JD + company context must appear?
5. How do you allocate stories across slots so nothing is repeated?
6. What should be cut or downplayed?

Return ONLY this JSON:
{
  "narrativeAngle": "The single hook sentence — why this candidate is uniquely right for this role",
  "topMatches": [
    "Experience X maps to requirement Y because Z",
    "Experience A maps to requirement B because C",
    "Experience D maps to requirement E because F"
  ],
  "gapsToMinimize": [
    "Gap: X — frame as: Y"
  ],
  "keywordsToHit": ["keyword1", "keyword2", "keyword3"],
  "storyAllocation": [
    { "slot": "resume bullets", "story": "which experience to lead with", "angle": "how to frame it" },
    { "slot": "cover letter", "story": "which story to use as the hook", "angle": "how to frame it" },
    { "slot": "question text here", "story": "which story to use", "angle": "how to frame it" }
  ],
  "whatToCut": ["experience or detail to omit or downplay and why"]
}`;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 6000,
      thinking: { type: "enabled", budget_tokens: 4000 } as any,
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
      return JSON.parse(cleaned.slice(start, end + 1)) as PositioningStrategy;
    }
  } catch { /* fall through to default */ }

  // Fallback: minimal strategy if extended thinking fails
  return {
    narrativeAngle: job.whyItFits,
    topMatches: [],
    gapsToMinimize: [],
    keywordsToHit: [],
    storyAllocation: slots.map(slot => ({ slot, story: "most relevant experience", angle: "direct match" })),
    whatToCut: []
  };
}
